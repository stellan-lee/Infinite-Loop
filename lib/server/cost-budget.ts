/*
 * GlobalCostBudget — a process-wide ceiling on cumulative provider-reported
 * run cost.
 *
 * `INFLOOP_MAX_RUN_COST_USD` (run-controller.ts) caps a SINGLE run. Nothing
 * caps the AGGREGATE: a webhook storm or a misconfigured trigger can start run
 * after run, each individually under its per-run cap, and spend the operator's
 * API budget without bound. For a system that runs unattended and spends real
 * money on every Agent node, that is a financial incident waiting to happen.
 * This budget closes that gap.
 *
 * `INFLOOP_MAX_TOTAL_COST_USD` sets the ceiling. Default `0` — opt-in, exactly
 * like the per-run cost cap: no single dollar figure is safe for every
 * deployment, and a surprise abort destroys uncommitted agent work, so the
 * operator sets it to their real budget. `0` (and any typo) disables it.
 *
 * Enforced at two points (see run-controller.ts / trigger-queue-singleton.ts):
 *
 *   - ADMISSION: `engineStartAdapter` refuses to start a new run once the
 *     budget is exhausted — the clean answer to a webhook storm.
 *   - MID-RUN:   `RunController.recordCost` trips an in-flight run at its next
 *     costed node once the budget is exhausted — bounds a single run, or a set
 *     of concurrent runs, that blows the budget after admission.
 *
 * Overshoot is expected and acceptable. The ceiling is checked AFTER a node's
 * cost is added (cost is only known once the node has run), and a per-run trip
 * only aborts that one run — so several concurrent runs can each settle a node
 * and collectively push past the ceiling before any trips. Like the per-run
 * cap, this is a "stop starting work and wind down" backstop, not a hard
 * real-time spend limit. Only providers that report cost contribute (currently
 * the `claude` CLI); HTTP providers report none.
 *
 * `spentUsd` is a LIVE accumulator: every settled node reports its cost here
 * via `add()`, so a long, expensive run is visible before it settles. This is
 * deliberately separate from `metrics.runCostUsdTotal`, which is folded once
 * per run at settle time and so could never trip a ceiling mid-run. The two
 * totals therefore diverge while runs are in flight and converge after — both
 * are correct; do not try to unify them.
 *
 * Process-lifetime, in-memory: a restart resets `spentUsd` to 0. A persisted
 * rolling-window (e.g. daily) budget is deliberately out of scope — it needs
 * durable atomic writes on the per-node hot path and a window-rollover policy.
 * The same in-memory character as `EventMemoryBudget` and the metrics
 * counters; the `infloop_run_cost_usd_total` counter remains the surface an
 * alert wires to for a windowed burn-rate view.
 *
 * This module imports nothing from the engine on purpose: run-controller.ts
 * imports it, so importing the engine back would close a module cycle through
 * a globalThis singleton — the same trap event-memory-budget.ts / metrics.ts
 * call out. Spend is therefore self-reported via `add()`.
 */

/** `0` — opt-in: there is no universally-safe default dollar ceiling. */
const DEFAULT_MAX_TOTAL_COST_USD = 0;

/**
 * Resolve the process-wide cost ceiling from the environment. A literal `0`
 * is meaningful — it disables the ceiling. A non-numeric or negative value is
 * a typo, not an intent, and falls back to the (also-disabled) default. Mirror
 * of `run-controller.ts`'s `readBudgetFloatEnv` semantics, NOT
 * `event-memory-budget.ts`'s — there `0` means "default" because an unbounded
 * buffer is a bug; here `0` legitimately means "no ceiling".
 */
export function resolveCostCeiling(): number {
  const raw = process.env.INFLOOP_MAX_TOTAL_COST_USD;
  if (raw === undefined || raw === '') return DEFAULT_MAX_TOTAL_COST_USD;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_TOTAL_COST_USD;
  return n;
}

export class GlobalCostBudget {
  /** Process-wide cost ceiling in USD. `0` disables enforcement. */
  readonly ceilingUsd: number;
  /** Cumulative provider-reported cost across every run since process start. */
  private spentUsd = 0;

  /** `ceilingUsd` defaults to the env-resolved value; tests pass a small one
   *  to exercise the trip without running real cost through the engine. */
  constructor(opts?: { ceilingUsd?: number }) {
    this.ceilingUsd = opts?.ceilingUsd ?? resolveCostCeiling();
  }

  /**
   * Fold one settled node's provider-reported cost into the process-wide
   * total. Called from `RunController.recordCost`, once per costed node.
   *
   * MUST stay fully synchronous — no `await`. Parallel branches and concurrent
   * runs call this; on Node's single thread an await-free read-modify-write of
   * `spentUsd` cannot interleave, so the accumulation is race-free. A
   * non-finite or non-positive value is ignored so a malformed cost cannot
   * poison the accumulator — the caller already filters, this is the belt.
   */
  add(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.spentUsd += costUsd;
  }

  /** True once cumulative spend has passed the ceiling. Always false when the
   *  ceiling is disabled (`0`). Uses `>` to match the per-run cost cap. */
  exceeded(): boolean {
    return this.ceilingUsd > 0 && this.spentUsd > this.ceilingUsd;
  }

  /** Cumulative provider-reported cost since process start. Exposed live as
   *  `infloop_cost_budget_spent_usd` on `/api/metrics`. */
  get spent(): number {
    return this.spentUsd;
  }

  /** Tests only. Drops cumulative spend back to process-start zero. */
  reset(): void {
    this.spentUsd = 0;
  }
}

// Pin the singleton to `globalThis` so Next.js dev-mode module reloads cannot
// fork it — same rationale as event-bus.ts / metrics.ts / event-memory-budget.ts.
// The producer (RunController), the admission gate (trigger-queue-singleton)
// and the reader (/api/metrics) must all share one instance.
declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopGlobalCostBudget: GlobalCostBudget | undefined;
}

export const globalCostBudget: GlobalCostBudget =
  globalThis.__infiniteLoopGlobalCostBudget ?? new GlobalCostBudget();
if (!globalThis.__infiniteLoopGlobalCostBudget) {
  globalThis.__infiniteLoopGlobalCostBudget = globalCostBudget;
}
