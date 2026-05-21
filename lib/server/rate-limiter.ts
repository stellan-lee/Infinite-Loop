/*
 * In-memory rate limiter for the two ingress surfaces that `INFLOOP_API_TOKEN`
 * does not gate: inbound webhook delivery and the browser login form.
 *
 * Infinite Loop is a single process, so a process-local limiter is the correct
 * scope — no shared store, no cross-instance coordination. State is purely
 * in-memory: a restart clears it, and a port-fallback second instance keeps its
 * own. That is fine for a defense-in-depth control.
 *
 * The algorithm is a token bucket. Each key gets a bucket that refills at a
 * steady rate up to a capacity equal to the per-window limit. A request
 * consumes one token; an empty bucket rejects the request and reports the wait
 * until the next token. Capacity equals the rate, so a whole window's budget
 * may be spent as an instantaneous burst — this is a *rate* limiter, not a
 * *burst* limiter. It is not what makes brute-forcing `INFLOOP_API_TOKEN`
 * infeasible (a 256-bit token does that); it caps log/audit/CPU churn and the
 * blast radius of a leaked webhook URL.
 *
 * See docs/security.md ("Rate limiting") for the deployment-level reasoning.
 */

/** Outcome of a rate-limit check. */
export interface RateLimitResult {
  /** True when a token was available and consumed — admit the request. */
  ok: boolean;
  /** Whole seconds until the next token, suitable for a `Retry-After` header.
   *  `0` when `ok` is true. */
  retryAfterSeconds: number;
}

interface Bucket {
  /** Fractional tokens currently available. */
  tokens: number;
  /** Epoch ms at which `tokens` was last recomputed. */
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  /** Epoch ms of the last idle-bucket sweep; the sweep runs at most once a
   *  window (see `check`). `0` forces a (no-op) sweep on the first call. */
  private lastSweep = 0;

  /**
   * @param getLimit per-window request ceiling, and the bucket capacity. Read
   *   on every `check()` — matching the per-call env-read pattern in
   *   audit-log.ts — so an env change takes effect without a restart.
   * @param windowMs refill window: a bucket refills `getLimit()` tokens over
   *   this span.
   */
  constructor(
    private readonly getLimit: () => number,
    private readonly windowMs: number,
  ) {}

  /**
   * Account for one request under `key` and decide whether to admit it.
   * `now` is injectable for tests; production callers omit it.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    const capacity = Math.max(1, Math.floor(this.getLimit()));
    const refillPerMs = capacity / this.windowMs;

    // Drop idle (fully refilled) buckets at most once per window, so the map
    // stays proportional to the *active* key set rather than every key ever
    // seen. Cheap, deterministic, and needs no background timer.
    if (now - this.lastSweep >= this.windowMs) {
      this.sweep(now, capacity, refillPerMs);
      this.lastSweep = now;
    }

    const bucket = this.buckets.get(key);
    if (!bucket) {
      // First request for this key: a full bucket, one token spent.
      this.buckets.set(key, { tokens: capacity - 1, updated: now });
      return { ok: true, retryAfterSeconds: 0 };
    }

    // Refill for elapsed time, capped at capacity. `elapsed` is clamped at 0 so
    // a backward wall-clock step can never mint tokens; the capacity cap also
    // clamps a bucket left above a freshly-lowered limit back into range.
    const elapsed = Math.max(0, now - bucket.updated);
    const tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updated = now;

    if (tokens >= 1) {
      bucket.tokens = tokens - 1;
      return { ok: true, retryAfterSeconds: 0 };
    }

    // Empty: keep the partial token and report the wait until the next one.
    bucket.tokens = tokens;
    const waitMs = (1 - tokens) / refillPerMs;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  /** Number of tracked buckets — for tests and observability. */
  size(): number {
    return this.buckets.size;
  }

  /** Drop all bucket state. Used by tests; also a valid operational reset.
   *  Mirrors `triggerQueue.clear()`. */
  reset(): void {
    this.buckets.clear();
    this.lastSweep = 0;
  }

  /** Delete every bucket that has fully refilled — it holds no state worth
   *  keeping, and a later request would recreate it identically. */
  private sweep(now: number, capacity: number, refillPerMs: number): void {
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, now - bucket.updated);
      if (bucket.tokens + elapsed * refillPerMs >= capacity) {
        this.buckets.delete(key);
      }
    }
  }
}

/* ─── env-backed limits ──────────────────────────────────────────────────── */

/** Read a positive-integer limit from the environment, falling back to
 *  `fallback` for an unset, non-numeric, or non-positive value. */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Refill window shared by both limiters: limits are expressed per minute. */
const WINDOW_MS = 60_000;

const DEFAULT_WEBHOOK_LIMIT = 120;
const DEFAULT_LOGIN_LIMIT = 20;

// Pin both limiters to `globalThis` so Next.js dev mode (which can recompile
// route modules on demand and produce more than one copy of this module
// graph) cannot end up with separate limiters per route — which would silently
// multiply the effective limit. Same pattern as event-bus.ts / trigger-queue.
declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopWebhookRateLimiter: RateLimiter | undefined;
  // eslint-disable-next-line no-var
  var __infiniteLoopLoginRateLimiter: RateLimiter | undefined;
}

/**
 * Webhook ingress limiter — keyed per `triggerId`.
 *
 * `INFLOOP_API_TOKEN` does not gate webhook ingress (external senders cannot
 * carry a bearer header), so the triggerId in the URL is the only credential.
 * This caps how hard a leaked trigger URL can be hammered. The key is the
 * triggerId alone, so the bucket map stays bounded by the real trigger count;
 * the tradeoff is that a flood on a leaked trigger also throttles that
 * trigger's legitimate traffic — the remedy for a leaked URL is to rotate it.
 */
export const webhookRateLimiter: RateLimiter =
  globalThis.__infiniteLoopWebhookRateLimiter ??
  new RateLimiter(
    () => envLimit('INFLOOP_WEBHOOK_RATE_LIMIT', DEFAULT_WEBHOOK_LIMIT),
    WINDOW_MS,
  );
if (!globalThis.__infiniteLoopWebhookRateLimiter) {
  globalThis.__infiniteLoopWebhookRateLimiter = webhookRateLimiter;
}

/**
 * Browser-login limiter — a single global bucket (one constant key).
 *
 * Infinite Loop is single-tenant: one shared `INFLOOP_API_TOKEN`, no per-user
 * accounts, so there is no per-client fairness to preserve. A global bucket is
 * also the only honest option — a per-IP key would collapse onto one bucket
 * with no proxy, key on an attacker-spoofable `X-Forwarded-For` behind one,
 * and let a spoofed-IP flood grow the map without bound. The cost is that a
 * sustained login flood can `429` the browser login form; the operator can
 * still authenticate API/MCP calls with `Authorization: Bearer`, which is not
 * behind this limiter.
 */
export const loginRateLimiter: RateLimiter =
  globalThis.__infiniteLoopLoginRateLimiter ??
  new RateLimiter(
    () => envLimit('INFLOOP_LOGIN_RATE_LIMIT', DEFAULT_LOGIN_LIMIT),
    WINDOW_MS,
  );
if (!globalThis.__infiniteLoopLoginRateLimiter) {
  globalThis.__infiniteLoopLoginRateLimiter = loginRateLimiter;
}

/** The single key under which `loginRateLimiter` tracks all login attempts. */
export const LOGIN_RATE_KEY = 'login';
