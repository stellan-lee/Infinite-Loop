import { requireAuth } from '@/lib/server/auth';
import { metrics } from '@/lib/server/metrics';
import { eventMemoryBudget } from '@/lib/server/event-memory-budget';
import { globalCostBudget } from '@/lib/server/cost-budget';
import { workflowEngine } from '@/lib/server/workflow-engine';
import { triggerQueue } from '@/lib/server/trigger-queue-singleton';

/**
 * GET /api/metrics — authenticated Prometheus metrics surface.
 *
 * Unlike `/api/health` (deliberately public, payload limited to non-sensitive
 * fields), this endpoint is auth-gated: run counts, cost, queue depth and
 * slot-pool saturation are operational detail and a reconnaissance signal, so
 * they must never answer unauthenticated. The endpoint is intentionally absent
 * from `middleware.ts`'s `isExempt` allowlist, and `requireAuth` is also
 * called here — defense in depth, matching every other token-gated route.
 *
 * Not audited: a scrape runs every ~15s and would flood the audit log with no
 * forensic value. The audit log records state-changing actions, not reads.
 *
 * `force-dynamic` — the body is live process state and must never be cached.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  // Gauges are collected here, not in the registry: the registry must not
  // import the engine (it would close an import cycle — see metrics.ts).
  const slotPool = workflowEngine.slotPool;
  const liveRuns = workflowEngine.list();
  const body = metrics.render({
    runsActive: liveRuns.length,
    slotPoolInUse: slotPool.size(),
    slotPoolCapacity: slotPool.getCapacity(),
    slotPoolWaiting: slotPool.waiterCount(),
    queueDepth: triggerQueue.size(),
    eventBufferEvents: liveRuns.reduce(
      (sum, run) => sum + run.bufferedEventCount(),
      0,
    ),
    eventBufferLimit: eventMemoryBudget.totalCap,
    costBudgetSpentUsd: globalCostBudget.spent,
    costBudgetLimitUsd: globalCostBudget.ceilingUsd,
    processUptimeSeconds: Math.round(process.uptime()),
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
