/**
 * Run-scoped token registry for the SetOutput MCP server.
 *
 * When an agent node declares `outputs`, the engine mints a token before
 * spawning the CLI, writes a per-invocation `mcp.json` referencing
 * `/api/mcp/output` with that token as the bearer, and consumes the
 * accumulated outputs when the CLI exits. Outputs then flow into the node's
 * `outputs` map alongside `stdout`/`stderr`/`exitCode`/etc.
 *
 * Lifecycle:
 *   mintToken(...)            → opaque token; entry stored in-memory
 *   resolveToken(token)       → entry or null (no side effects)
 *   setOutput(token, k, v)    → validates k against allowedKeys, caps v
 *   consumeOutputs(token)     → drains+revokes; returns the accumulated map
 *   releaseRun(runId)         → sweeps entries for a finished run
 *
 * Crash safety:
 *   - Agent executor's `finally` block (consumeOutputs) is the primary
 *     cleanup path; the registry entry is gone before the engine even moves
 *     past the node.
 *   - `releaseRun` sweep on engine run-settle is the secondary backstop:
 *     covers crashes between mint and consume.
 *   - Sliding-window TTL refreshed on every successful setOutput call is the
 *     last-resort fallback. Covers long-running agents (including
 *     `LoopConfig.infinite` runs) without leaking entries forever if the
 *     engine itself crashed before settle. Default 1h since last activity,
 *     configurable via `INFLOOP_MCP_TOKEN_TTL_MS`.
 *
 * Multi-process: NOT supported. State lives in this module's closure; the
 * InfLoop server is single-process by design (see server.ts).
 *
 * Auth helper `requireRunToken` lives here for v1 because it's the sole
 * consumer. If a second MCP route ever needs token auth, extract it to
 * `lib/server/mcp/auth.ts` rather than growing this module.
 */

import { NextResponse } from 'next/server';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/* ─── constants & types ──────────────────────────────────────────────────── */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h sliding window
const DEFAULT_VALUE_MAX_BYTES = 64 * 1024; // 64 KB

function ttlMs(): number {
  const raw = process.env.INFLOOP_MCP_TOKEN_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function valueMaxBytes(): number {
  const raw = process.env.INFLOOP_MCP_VALUE_MAX_BYTES;
  if (!raw) return DEFAULT_VALUE_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VALUE_MAX_BYTES;
}

export interface OutputDecl {
  name: string;
  description?: string;
}

export interface RegistryEntry {
  runId: string;
  nodeId: string;
  outputDecls: OutputDecl[];
  allowedKeys: Set<string>;
  outputs: Record<string, string>;
  /** Monotonic epoch ms of last successful activity (mint counts as activity). */
  lastTouchedAt: number;
}

export interface SetOutputResult {
  ok: true;
}

export interface SetOutputError {
  ok: false;
  code: 'unknown_token' | 'unknown_key' | 'invalid_value' | 'value_too_large';
  message: string;
}

/* ─── storage ─────────────────────────────────────────────────────────────── */

const tokens = new Map<string, RegistryEntry>();

/** Test hook only. */
export function __resetRegistryForTests(): void {
  tokens.clear();
}

/* ─── API ─────────────────────────────────────────────────────────────────── */

export interface MintArgs {
  runId: string;
  nodeId: string;
  outputDecls: OutputDecl[];
}

export function mintToken(args: MintArgs): string {
  const token = randomBytes(32).toString('hex');
  const allowedKeys = new Set(args.outputDecls.map((d) => d.name));
  tokens.set(token, {
    runId: args.runId,
    nodeId: args.nodeId,
    outputDecls: args.outputDecls,
    allowedKeys,
    outputs: {},
    lastTouchedAt: Date.now(),
  });
  return token;
}

export function resolveToken(token: string): RegistryEntry | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.lastTouchedAt > ttlMs()) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

export function setOutput(
  token: string,
  key: string,
  value: unknown,
): SetOutputResult | SetOutputError {
  const entry = resolveToken(token);
  if (!entry) {
    return { ok: false, code: 'unknown_token', message: 'token revoked or unknown' };
  }
  if (!entry.allowedKeys.has(key)) {
    return {
      ok: false,
      code: 'unknown_key',
      message: `key "${key}" is not declared in this node's outputs`,
    };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      code: 'invalid_value',
      message: 'value must be a string (v1 supports string outputs only)',
    };
  }
  const max = valueMaxBytes();
  // Cheap upper bound: JS string length is char count; cap on byte length is
  // tighter. Reject if either crosses the budget so a malicious agent can't
  // OOM the engine.
  if (value.length > max || Buffer.byteLength(value, 'utf8') > max) {
    return {
      ok: false,
      code: 'value_too_large',
      message: `value exceeds ${max} bytes`,
    };
  }
  entry.outputs[key] = value;
  entry.lastTouchedAt = Date.now();
  return { ok: true };
}

/**
 * Drain and revoke a token. Returns whatever outputs were set; returns an
 * empty object if the token is unknown (already revoked or expired). Late
 * `setOutput` calls after consume return `unknown_token` — never silently
 * buffer into a future invocation.
 */
export function consumeOutputs(token: string): Record<string, string> {
  const entry = tokens.get(token);
  if (!entry) return {};
  tokens.delete(token);
  return entry.outputs;
}

/** Sweep every entry belonging to a run. Called by the engine on settle. */
export function releaseRun(runId: string): void {
  for (const [token, entry] of tokens) {
    if (entry.runId === runId) tokens.delete(token);
  }
}

/* ─── auth helper ────────────────────────────────────────────────────────── */

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Validate `Authorization: Bearer <run-token>` against the in-memory
 * registry. Returns the resolved entry on success, or a 401 NextResponse on
 * failure. Distinct from `requireAuth` (lib/server/auth.ts), which guards
 * the global API surface with `INFLOOP_API_TOKEN`.
 *
 * Response shape matches `requireAuth` (`{error: 'unauthorized'}`) so the
 * 401 path is consistent across the API.
 */
export function requireRunToken(
  req: Request,
): { entry: RegistryEntry; token: string } | NextResponse {
  const header = req.headers.get('authorization');
  if (!header) return unauthorized();
  const match = /^bearer\s+(\S.*)$/i.exec(header);
  if (!match) return unauthorized();
  const presented = match[1]!.trim();
  if (presented.length === 0) return unauthorized();

  // Constant-time compare against each known token. The number of live
  // tokens is bounded by concurrent agent runs, so O(N) is fine in practice.
  // We still iterate the full set even on a hit to keep timing flat across
  // the "right token" vs "no token" paths.
  let matched: RegistryEntry | null = null;
  let matchedToken: string | null = null;
  const presentedBuf = Buffer.from(presented, 'utf8');
  for (const [candidate, entry] of tokens) {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (
      candidateBuf.length === presentedBuf.length &&
      timingSafeEqual(candidateBuf, presentedBuf)
    ) {
      matched = entry;
      matchedToken = candidate;
    }
  }
  if (!matched || !matchedToken) return unauthorized();
  // Gate the sliding-window TTL BEFORE we touch lastTouchedAt — otherwise an
  // expired entry that's still in the map would be resurrected by the very
  // act of checking it.
  if (Date.now() - matched.lastTouchedAt > ttlMs()) {
    tokens.delete(matchedToken);
    return unauthorized();
  }
  matched.lastTouchedAt = Date.now();
  return { entry: matched, token: matchedToken };
}
