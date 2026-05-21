import { TriggerQueue } from './trigger-queue';
import { workflowEngine, type WorkflowEngine } from './workflow-engine';
import { getWorkflow } from './workflow-store';
import { touchLastFired } from './trigger-store';
import { persistQueuedRun, removeQueuedRun } from './queue-store';
import { eventBus } from './event-bus';
// Side-effect: register the queueHistory event-bus subscription at the same
// point the queue itself is wired, so history mirrors every queue event
// regardless of which entry point (MCP route, webhook, /api/triggers, …)
// happens to load the queue first.
import './queue-history';
import { createLogger } from './logger';
import type { Workflow } from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';

const log = createLogger('trigger-queue');

/**
 * Synchronous start: returns the runId immediately. Multi-run safe — there
 * is no busy state to pre-check; the registry admits every run. Folder-
 * touching runs are throttled inside `controller.start` → first lock
 * acquire → slot pool wait. Folder-free runs run unlimited.
 *
 * Kept exported so existing imports continue to work and so /api/run can
 * call it directly. The old engineStartAdapter has been retired as part of
 * stage 5 (concurrent-runs refactor).
 */
export function engineStartAdapter(
  engine: WorkflowEngine,
  wf: Workflow,
  opts: { resolvedInputs: ResolvedInputs },
): Promise<string> {
  const { runId, completion } = engine.startRun(wf, opts);
  // Swallow the completion rejection here so callers reading the synchronous
  // runId don't get an unhandled rejection. The run's terminal status flows
  // through events; engine.getRun(runId).snapshot.errorMessage carries any
  // failure detail.
  completion.catch((err) => {
    log.error('run completion rejected', { err });
  });
  return Promise.resolve(runId);
}

function createSingleton(): TriggerQueue {
  const q = new TriggerQueue({
    engineStart: (wf, opts) => engineStartAdapter(workflowEngine, wf, opts),
    loadWorkflow: getWorkflow,
    touchLastFired: (id) => touchLastFired(id),
    // Mirror queued runs to disk so a restart between a trigger's 202 ack and
    // the drain does not lose them silently. crash-recovery.reconcileQueuedRuns
    // re-enqueues the survivors on the next boot.
    persistence: { add: persistQueuedRun, remove: removeQueuedRun },
    maxQueue: 100,
  });

  // Drain whenever a run settles.
  eventBus.subscribe((ev) => {
    if (ev.type === 'run_finished') {
      void q.drain();
    }
  });

  // Best-effort drain at module load in case items were enqueued during a
  // recent terminal-state transition. Safe — drain() is self-guarded.
  void q.drain();

  return q;
}

declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopTriggerQueue: TriggerQueue | undefined;
}

export const triggerQueue: TriggerQueue =
  globalThis.__infiniteLoopTriggerQueue ?? createSingleton();
if (!globalThis.__infiniteLoopTriggerQueue) {
  globalThis.__infiniteLoopTriggerQueue = triggerQueue;
}
