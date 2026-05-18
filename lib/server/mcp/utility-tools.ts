import { getRun, listRuns as storeListRuns } from '@/lib/server/run-store';
import { workflowEngine } from '@/lib/server/workflow-engine';
import { triggerQueue } from '@/lib/server/trigger-queue-singleton';
import { queueHistory } from '@/lib/server/queue-history';
import { filterOutputs } from './filter-outputs';

export interface RunStatusResult {
  status: string;
  runId?: string;
  queueId?: string;
  position?: number;
  durationMs?: number;
  outputs?: Record<string, unknown>;
  errorMessage?: string;
  error?: string;
  reason?: string;
  /** Set when the run is parked waiting on a directory lock or concurrency
   *  slot. Cleared once the wait resolves. */
  waitingFor?: {
    kind: 'lock' | 'slot';
    nodeId: string;
    path?: string;
    heldByRunId?: string;
    heldByPath?: string;
  };
}

async function lookupByRunId(
  workflowId: string,
  runId: string,
): Promise<RunStatusResult> {
  try {
    const run = await getRun(workflowId, runId);
    return {
      status: run.status,
      runId: run.runId,
      durationMs: run.durationMs,
      outputs: filterOutputs(run.scope),
      errorMessage: run.errorMessage,
    };
  } catch {
    // Fall through to engine snapshot.
  }

  // Look up live controller by runId (multi-run aware). Falls back to the
  // engine's last-snapshot for back-compat.
  const ctrl = workflowEngine.getRun(runId);
  const snap = ctrl ? ctrl.getState() : workflowEngine.getState();
  if (snap.runId === runId && snap.workflowId === workflowId) {
    return {
      status: snap.status,
      runId: snap.runId,
      durationMs:
        snap.finishedAt != null && snap.startedAt != null
          ? snap.finishedAt - snap.startedAt
          : undefined,
      outputs: filterOutputs(snap.scope),
      errorMessage: snap.errorMessage,
      waitingFor: snap.waitingFor,
    };
  }

  return { status: 'error', error: `Run ${runId} not found.` };
}

export async function getRunStatus(args: {
  workflowId?: string;
  runId?: string;
  queueId?: string;
}): Promise<RunStatusResult> {
  // queueId path: resolve to a runId via the queue history.
  if (args.queueId) {
    const hist = queueHistory.get(args.queueId);
    if (!hist) {
      return {
        status: 'error',
        error: `Queue id ${args.queueId} not found. It may have expired or never existed.`,
      };
    }
    if (hist.state === 'queued') {
      const all = triggerQueue.list();
      const idx = all.findIndex((i) => i.queueId === args.queueId);
      return {
        status: 'queued',
        queueId: args.queueId,
        position: idx >= 0 ? idx + 1 : undefined,
      };
    }
    if (hist.state === 'removed' || hist.state === 'dropped') {
      return {
        status: hist.state,
        queueId: args.queueId,
        reason: hist.reason,
      };
    }
    // state === 'started'
    if (!hist.runId) {
      return {
        status: 'error',
        error: `Queue item ${args.queueId} started but has no runId yet.`,
      };
    }
    const out = await lookupByRunId(hist.workflowId, hist.runId);
    return { ...out, queueId: args.queueId };
  }

  if (!args.runId || !args.workflowId) {
    return {
      status: 'error',
      error: 'Must provide either {workflowId, runId} or {queueId}.',
    };
  }

  return lookupByRunId(args.workflowId, args.runId);
}

export async function listRuns(args: {
  workflowId?: string;
}): Promise<{ runs: unknown[] }> {
  const runs = await storeListRuns(args.workflowId);
  return { runs };
}

export async function cancelRun(args: {
  workflowId: string;
  runId: string;
}): Promise<{ cancelled: boolean; reason?: string }> {
  const ctrl = workflowEngine.getRun(args.runId);
  if (!ctrl || ctrl.snapshot.status !== 'running') {
    return {
      cancelled: false,
      reason: `Run ${args.runId} is not active.`,
    };
  }
  workflowEngine.stop(args.runId);
  return { cancelled: true };
}

export interface QueueListItem {
  queueId: string;
  triggerId: string;
  workflowId: string;
  workflowName: string;
  receivedAt: number;
  position: number;
}

export function listQueue(): { size: number; items: QueueListItem[] } {
  const all = triggerQueue.list();
  const items = all.map((item, idx) => ({
    queueId: item.queueId,
    triggerId: item.triggerId,
    workflowId: item.workflow.id,
    workflowName: item.workflow.name,
    receivedAt: item.receivedAt,
    position: idx + 1,
  }));
  return { size: all.length, items };
}

export function removeFromQueue(args: {
  queueId: string;
}): { removed: boolean; reason?: string } {
  const { removed } = triggerQueue.removeByQueueId(args.queueId);
  if (!removed) {
    return { removed: false, reason: 'not-in-queue' };
  }
  return { removed: true };
}
