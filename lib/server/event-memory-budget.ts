/*
 * EventMemoryBudget — a process-wide ceiling on how many workflow events all
 * live runs may buffer in memory at once.
 *
 * Each RunController buffers its run's events twice: `recentEvents` (the SSE
 * replay buffer) and `runEventLog` (the to-be-persisted log). Both arrays are
 * capped PER RUN — 5k and 50k events (run-controller.ts). Nothing caps the
 * AGGREGATE: N concurrent runs hold up to N x 50k event objects, and a webhook
 * flood can admit ~100 runs (`TriggerQueue.maxQueue`) before the first one
 * settles. Events carry agent stdout, so an unbounded aggregate is a real
 * process-OOM vector — an inbound webhook could crash the server.
 *
 * This budget closes that gap. It does NOT track bytes (event sizes vary
 * wildly and an exact byte count is costly per push); it bounds the EVENT
 * COUNT — the same proxy the existing per-run caps already use. Every live run
 * registers here, and each run's effective persisted-event cap becomes the
 * budget divided fairly among the live runs:
 *
 *     perRunEventCap = max(MIN_PER_RUN_EVENT_CAP, floor(totalCap / activeRuns))
 *
 * A lone run keeps the full per-run hard cap (the fair share dwarfs it). Under
 * a 100-run flood every run is squeezed toward `totalCap / 100`, so the
 * aggregate plateaus at ~`totalCap` instead of growing without bound. Because
 * `floor()` only ever rounds a share down, `activeRuns x perRunEventCap` stays
 * within `totalCap` for every concurrency level up to `totalCap /
 * MIN_PER_RUN_EVENT_CAP` runs; beyond that the floor trades a gently higher
 * bound (`activeRuns x MIN`) for keeping each run a usable tail of recent
 * events — still far below the unbounded `activeRuns x 50k` of the pre-budget
 * engine.
 *
 * Why a fair-share cap and not admission refusal: refusing to admit a run
 * means dropping queued work (data loss), and the per-run buffers make the
 * RunController the natural enforcement point. Squeezing the buffers — the
 * same evict-oldest truncation a single run's cap already does — is the
 * narrow, lossless fix for the OOM vector.
 *
 * This module imports nothing from the engine on purpose: run-controller.ts
 * imports it, so importing the engine back would close a module cycle through
 * a globalThis singleton — the fragile kind metrics.ts's header also avoids.
 * Live-run accounting is therefore self-reported via `register`/`unregister`.
 */

/**
 * Default aggregate ceiling, in events, when `INFLOOP_MAX_TOTAL_EVENT_BUFFER`
 * is unset. At a rough ~1-2 KB per event this is a few hundred MB — generous
 * headroom for the documented 100-run webhook flood, and far below an OOM.
 */
const DEFAULT_TOTAL_EVENT_CAP = 200_000;

/**
 * Floor on a single run's fair share. Below `totalCap / MIN` concurrent runs
 * the computed share exceeds this and the aggregate bound is exactly
 * `totalCap`; beyond that the floor keeps every run a usable tail of recent
 * events at the cost of a gently higher aggregate bound (`activeRuns x MIN`).
 */
const MIN_PER_RUN_EVENT_CAP = 500;

/**
 * Resolve the aggregate event-buffer ceiling from the environment. A literal
 * `0`, a negative, or a non-numeric value is a typo, not an intent to disable
 * (an unbounded buffer is the very bug this guards) — fall back to the default.
 */
export function resolveTotalEventCap(): number {
  const raw = process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER;
  if (raw === undefined || raw === '') return DEFAULT_TOTAL_EVENT_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOTAL_EVENT_CAP;
  return n;
}

export class EventMemoryBudget {
  /** Aggregate ceiling on buffered events across all live runs. */
  readonly totalCap: number;
  /** Live runs currently buffering events — kept by register/unregister. */
  private active = 0;

  /** `totalCap` defaults to the env-resolved ceiling; tests pass a small one
   *  to exercise backpressure without buffering hundreds of thousands of
   *  events. */
  constructor(opts?: { totalCap?: number }) {
    this.totalCap = opts?.totalCap ?? resolveTotalEventCap();
  }

  /** A run has started buffering events. Pair with exactly one `unregister`. */
  register(): void {
    this.active += 1;
  }

  /** A run has stopped buffering events. Clamped at 0 so a stray unbalanced
   *  call cannot drive the count negative and inflate every fair share. */
  unregister(): void {
    if (this.active > 0) this.active -= 1;
  }

  /** Live runs currently buffering events. */
  get activeRuns(): number {
    return this.active;
  }

  /**
   * The fair-share persisted-event cap for one run at the current
   * concurrency. The caller (RunController) still clamps this by its own
   * per-run hard cap — a single run never exceeds `PERSIST_EVENT_CAP` even
   * when the fair share would allow more.
   */
  perRunEventCap(): number {
    const share = Math.floor(this.totalCap / Math.max(1, this.active));
    return Math.max(MIN_PER_RUN_EVENT_CAP, share);
  }

  /** Tests only. Drops the live-run count back to zero. */
  reset(): void {
    this.active = 0;
  }
}

// Pin the singleton to `globalThis` so Next.js dev-mode module reloads cannot
// fork it — same rationale as event-bus.ts / metrics.ts. The producer
// (RunController) and the reader (/api/metrics) must share one instance.
declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopEventMemoryBudget: EventMemoryBudget | undefined;
}

export const eventMemoryBudget: EventMemoryBudget =
  globalThis.__infiniteLoopEventMemoryBudget ?? new EventMemoryBudget();
if (!globalThis.__infiniteLoopEventMemoryBudget) {
  globalThis.__infiniteLoopEventMemoryBudget = eventMemoryBudget;
}
