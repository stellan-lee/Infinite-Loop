import { eventBus, type EventBus } from './event-bus';

export type QueueEntryState = 'queued' | 'started' | 'dropped' | 'removed';

export interface QueueHistoryEntry {
  queueId: string;
  triggerId: string;
  workflowId: string;
  state: QueueEntryState;
  runId?: string;
  /** Correlation id of the ingress event behind this queue item — keeps the
   *  live queue view part of the webhook → queue → run trace. */
  correlationId?: string;
  reason?: string;
  enqueuedAt: number;
  updatedAt: number;
}

const MAX_ENTRIES = 200;

class QueueHistory {
  private map = new Map<string, QueueHistoryEntry>();

  get(queueId: string): QueueHistoryEntry | undefined {
    return this.map.get(queueId);
  }

  set(entry: QueueHistoryEntry): void {
    this.map.delete(entry.queueId);
    this.map.set(entry.queueId, entry);
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** Wire `history` to the given event bus. Returns the unsubscribe handle.
 *  Exported for tests that clear the bus between cases and need to
 *  re-register the subscription. */
export function subscribeQueueHistory(
  history: QueueHistory,
  bus: EventBus = eventBus,
): () => void {
  return bus.subscribe((ev) => {
    if (ev.type === 'trigger_enqueued') {
      history.set({
        queueId: ev.queueId,
        triggerId: ev.triggerId,
        workflowId: ev.workflowId,
        state: 'queued',
        correlationId: ev.correlationId,
        enqueuedAt: ev.receivedAt,
        updatedAt: Date.now(),
      });
    } else if (ev.type === 'trigger_started') {
      const prev = history.get(ev.queueId);
      history.set({
        queueId: ev.queueId,
        triggerId: ev.triggerId,
        workflowId: ev.workflowId,
        state: 'started',
        runId: ev.runId,
        correlationId: ev.correlationId ?? prev?.correlationId,
        enqueuedAt: prev?.enqueuedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    } else if (ev.type === 'trigger_removed') {
      const prev = history.get(ev.queueId);
      history.set({
        queueId: ev.queueId,
        triggerId: ev.triggerId,
        workflowId: ev.workflowId,
        state: 'removed',
        reason: ev.reason,
        correlationId: ev.correlationId ?? prev?.correlationId,
        enqueuedAt: prev?.enqueuedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    } else if (ev.type === 'trigger_dropped') {
      const prev = history.get(ev.queueId);
      // A `trigger_dropped` from drain() (workflow-deleted / engine-start-
      // failed) is preceded by a `trigger_enqueued`. A `queue-full` drop is
      // emitted by enqueue() for an item that was never admitted to the queue,
      // so it legitimately has no prior history. Either way, with no `prev`
      // there is nothing to transition — skip instead of fabricating a
      // workflowId.
      if (!prev) return;
      history.set({
        ...prev,
        state: 'dropped',
        reason: ev.reason,
        updatedAt: Date.now(),
      });
    }
  });
}

function createSingleton(): QueueHistory {
  const h = new QueueHistory();
  subscribeQueueHistory(h);
  return h;
}

declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopQueueHistory: QueueHistory | undefined;
}

export const queueHistory: QueueHistory =
  globalThis.__infiniteLoopQueueHistory ?? createSingleton();
if (!globalThis.__infiniteLoopQueueHistory) {
  globalThis.__infiniteLoopQueueHistory = queueHistory;
}

export { QueueHistory };
