import type {
  EdgeHandle,
  HumanDecisionRecord,
  ManualConfig,
  ManualDecisionDecl,
  ManualDecisionKey,
  NodeExecutor,
  NodeExecutorContext,
  NodeExecutorResult,
} from '../../shared/workflow';
import { MANUAL_DEFAULT_DECISIONS } from '../../shared/workflow';

/**
 * Manual / human-acceptance gate executor.
 *
 * Pauses the run by awaiting `ctx.awaitHumanDecision()`, which the engine
 * resolves once an authorized reviewer hits `POST /api/runs/.../decision`
 * (or, optionally, when the config-declared timeout elapses). The decision
 * record is written to scope so downstream nodes can branch on
 * `{{<manual-id>.decision}}` / `{{<manual-id>.comment}}` etc.
 *
 * Productized — does NOT hardcode any reviewer identity, agent name, or
 * persona. `reviewerHint` is operator-facing guidance only; identity belongs
 * upstream of this server (single-tenant by design — see
 * lib/server/auth.ts).
 */
export const manualExecutor: NodeExecutor = {
  async execute(ctx: NodeExecutorContext): Promise<NodeExecutorResult> {
    if (ctx.signal.aborted) {
      return { outputs: { errorMessage: 'aborted' }, branch: 'error' };
    }

    if (!ctx.awaitHumanDecision) {
      // Defensive: the engine always plumbs this through, but a unit-test
      // context that hand-builds the ctx might forget. Surface a clear
      // diagnostic rather than hanging the run.
      return {
        outputs: {
          errorMessage:
            'manual node: engine did not provide awaitHumanDecision — run from the engine, not a raw executor harness',
        },
        branch: 'error',
      };
    }

    const cfg = (ctx.config ?? {}) as ManualConfig;
    const decisions = normalizeDecisions(cfg.decisions);

    let record: HumanDecisionRecord;
    try {
      record = await ctx.awaitHumanDecision({
        brief: typeof cfg.brief === 'string' ? cfg.brief : '',
        reviewerHint:
          typeof cfg.reviewerHint === 'string' && cfg.reviewerHint.length > 0
            ? cfg.reviewerHint
            : undefined,
        decisions,
        timeoutMs:
          typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0
            ? cfg.timeoutMs
            : undefined,
      });
    } catch (err) {
      // The engine rejects this promise when the run is aborted while parked
      // (or, hypothetically, an internal error in the wait machinery). Both
      // cases route through the normal abort path — the executeNode wrapper
      // already maps signal.aborted to cancelled.
      if (ctx.signal.aborted) {
        return { outputs: { errorMessage: 'aborted' }, branch: 'error' };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        outputs: { errorMessage: `manual gate failed: ${message}` },
        branch: 'error',
      };
    }

    const outputs: Record<string, unknown> = {
      decision: record.decision,
      decidedBy: record.decidedBy,
      decidedAt: record.decidedAt,
      ...(record.comment !== undefined ? { comment: record.comment } : {}),
      ...(record.timedOut ? { timedOut: true } : {}),
    };

    return {
      outputs,
      branch: record.decision satisfies ManualDecisionKey as EdgeHandle,
    };
  },
};

/** Materialize the configured decision set, filling defaults when omitted.
 *  Exported only by virtue of being the executor's helper — kept local so
 *  the default policy lives in one place. */
function normalizeDecisions(
  declared: ManualDecisionDecl[] | undefined,
): ManualDecisionDecl[] {
  if (declared && declared.length > 0) return declared;
  return MANUAL_DEFAULT_DECISIONS.map((key) => ({ key }));
}
