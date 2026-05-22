import type { Workflow } from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';
import { eventBus } from './event-bus';
import { createLogger } from './logger';
import { newCorrelationId } from './correlation';

const log = createLogger('trigger-queue');

export interface QueuedRun {
  queueId: string;
  workflow: Workflow;
  resolvedInputs: ResolvedInputs;
  triggerId: string;
  /** Correlation id of the ingress event (webhook / MCP) that enqueued this
   *  run — threaded into the run so its events, audit entries, and history
   *  record all join back to the trigger. See lib/server/correlation.ts. */
  correlationId: string;
  receivedAt: number;
}

/**
 * Disk persistence for the queue. Optional: when absent the queue is purely
 * in-memory (the historical behavior, kept for unit tests). The singleton
 * wires the disk-backed implementation from queue-store.ts. `add` runs inside
 * the synchronous `enqueue()`, so it must be synchronous and best-effort —
 * see queue-store.persistQueuedRun.
 */
export interface QueuePersistence {
  add(item: QueuedRun): void;
  remove(queueId: string): void;
}

/** The slice of TriggerQueue that crash recovery needs to re-admit and kick
 *  off persisted survivors. Declared here so crash-recovery.ts can depend on
 *  the contract without importing the queue's whole construction graph. */
export interface QueueRestoreTarget {
  restore(items: QueuedRun[]): void;
  drain(): Promise<void>;
}

export interface TriggerQueueDeps {
  /** Returns the new run's id on success. Throws if the engine is busy. */
  engineStart: (
    wf: Workflow,
    opts: { resolvedInputs: ResolvedInputs; correlationId: string },
  ) => Promise<string>;
  /** Re-fetch the freshest workflow JSON by id. Used to detect deletions. */
  loadWorkflow: (id: string) => Promise<Workflow>;
  /** Called after a successful engine start to record the fire time on the
   *  persisted trigger. Optional for tests that don't care. */
  touchLastFired?: (triggerId: string) => Promise<void>;
  /** Mirror queued runs to disk so a restart does not lose them. Optional:
   *  unit tests run the queue in-memory only. */
  persistence?: QueuePersistence;
  maxQueue?: number;
}

// The pre-stage-5 trigger queue used to catch a "run is already active"
// error from engineStart and re-prepend the head, waiting for the next
// `run_finished` event before retrying. With lazy slot admission, the
// engine no longer rejects starts on busy — every start admits, and
// folder-touching back-pressure happens inside the lock manager. Custom
// engineStart implementations may still reject for other reasons; those
// surface as `trigger_dropped { reason: 'engine-start-failed' }`.

export class TriggerQueue {
  private q: QueuedRun[] = [];
  private nextId = 0;
  private draining = false;
  private engineStart: TriggerQueueDeps['engineStart'];
  private loadWorkflow: TriggerQueueDeps['loadWorkflow'];
  private touchLastFired?: TriggerQueueDeps['touchLastFired'];
  private persistence?: QueuePersistence;
  private maxQueue: number;

  constructor(deps: TriggerQueueDeps) {
    this.engineStart = deps.engineStart;
    this.loadWorkflow = deps.loadWorkflow;
    this.touchLastFired = deps.touchLastFired;
    this.persistence = deps.persistence;
    this.maxQueue = deps.maxQueue ?? 100;
  }

  size(): number { return this.q.length; }

  peek(): QueuedRun | undefined { return this.q[0]; }

  list(): QueuedRun[] {
    return [...this.q];
  }

  removeByQueueId(queueId: string): { removed: boolean } {
    const idx = this.q.findIndex((item) => item.queueId === queueId);
    if (idx === -1) return { removed: false };
    const [item] = this.q.splice(idx, 1);
    this.persistence?.remove(item.queueId);
    eventBus.emit({
      type: 'trigger_removed',
      queueId: item.queueId,
      triggerId: item.triggerId,
      workflowId: item.workflow.id,
      correlationId: item.correlationId,
      reason: 'user-cancelled',
    });
    return { removed: true };
  }

  /**
   * Add a run to the queue. The caller may supply a `correlationId` (webhook /
   * MCP ingress mints one to thread the trace); when omitted — internal
   * callers, unit tests — a fresh one is minted so every queued run, and the
   * run it becomes, always carries one.
   */
  enqueue(
    item: Omit<QueuedRun, 'queueId' | 'correlationId'> & { correlationId?: string },
  ): { queueId: string; position: number; correlationId: string } {
    if (this.q.length >= this.maxQueue) {
      // The queue is at its cap — this item is shed before it ever enters the
      // queue. Emit `trigger_dropped{reason:"queue-full"}` so the shed is
      // counted in `infloop_queue_dropped_total` and the
      // `InfiniteLoopTriggerQueueDropping` alert can fire. Without this emit
      // the queue-full counter sat permanently at 0 (caught by the production
      // burn-in). There is no real queueId — the item was never queued — so a
      // synthetic one is used: the metrics registry keys only on `reason`, and
      // queue-history skips a dropped event with no matching `trigger_enqueued`.
      eventBus.emit({
        type: 'trigger_dropped',
        queueId: `rejected-${Date.now()}-${++this.nextId}`,
        triggerId: item.triggerId,
        correlationId: item.correlationId,
        reason: 'queue-full',
      });
      const err = new Error('trigger queue is full');
      (err as Error & { code?: string }).code = 'QUEUE_FULL';
      throw err;
    }
    // The `Date.now()` prefix makes the id restart-safe by construction: a
    // boot's clock is past the previous boot's, so a fresh id can never
    // collide with one carried in by restore() even though `nextId` resets.
    const queueId = `q-${Date.now()}-${++this.nextId}`;
    const correlationId = item.correlationId ?? newCorrelationId();
    const full: QueuedRun = { ...item, queueId, correlationId };
    // Persist before the item becomes observable — pushed, emitted, or
    // returned to the caller, which then sends its 202 ack. The durable
    // record must exist before that promise is made.
    this.persistence?.add(full);
    this.q.push(full);
    const position = this.q.length;
    eventBus.emit({
      type: 'trigger_enqueued',
      queueId,
      triggerId: full.triggerId,
      workflowId: full.workflow.id,
      correlationId,
      inputs: full.resolvedInputs,
      position,
      receivedAt: full.receivedAt,
    });
    return { queueId, position, correlationId };
  }

  /** Pull the head item and try to start it. Once shifted off, an item leaves
   *  the queue for good — started, dropped, or its workflow gone — so the
   *  per-item `finally` drops its persisted file in every case. Continues
   *  until the queue is empty. */
  async drain(): Promise<void> {
    if (this.draining) return;
    if (this.q.length === 0) return;
    this.draining = true;
    try {
      while (this.q.length > 0) {
        const head = this.q.shift()!;
        // Set when the head is refused because the process-wide cost budget is
        // exhausted — its persisted file is then kept and it is re-queued.
        let budgetPaused = false;
        try {
          let workflow: Workflow;
          try {
            workflow = await this.loadWorkflow(head.workflow.id);
          } catch {
            eventBus.emit({
              type: 'trigger_dropped',
              queueId: head.queueId,
              triggerId: head.triggerId,
              correlationId: head.correlationId,
              reason: 'workflow-deleted',
            });
            continue;
          }

          try {
            const runId = await this.engineStart(workflow, {
              resolvedInputs: head.resolvedInputs,
              correlationId: head.correlationId,
            });
            // engineStart resolved → RunController.start() has synchronously
            // written the run's crash-recovery marker (run-store.ts), so the
            // run is now durably tracked. Drop the queue file right here —
            // before touchLastFired's I/O — so a crash mid-hand-off can at
            // worst re-run this item (the marker also survives), never lose
            // it. The `finally` below is the catch-all; this is the early,
            // narrow point that keeps that re-run window sub-millisecond.
            this.persistence?.remove(head.queueId);
            eventBus.emit({
              type: 'trigger_started',
              queueId: head.queueId,
              triggerId: head.triggerId,
              workflowId: workflow.id,
              correlationId: head.correlationId,
              runId,
            });
            if (this.touchLastFired) {
              try { await this.touchLastFired(head.triggerId); }
              catch (err) { log.error('touchLastFired failed', { err }); }
            }
          } catch (err) {
            // A run refused because the process-wide cost budget is exhausted
            // is not this item's fault — every queued run would be refused the
            // same way. Pause the drain with the item still queued rather than
            // dropping it: the webhook that enqueued it was already given a
            // 202 ack, so a silent drop would break that promise.
            if ((err as { code?: string }).code === 'COST_BUDGET_EXCEEDED') {
              budgetPaused = true;
            } else {
              eventBus.emit({
                type: 'trigger_dropped',
                queueId: head.queueId,
                triggerId: head.triggerId,
                correlationId: head.correlationId,
                reason: 'engine-start-failed',
              });
              log.error('engineStart failed', {
                err,
                correlationId: head.correlationId,
              });
            }
          }
        } finally {
          // The item is out of the in-memory queue and processed to a terminal
          // outcome. Drop its persisted file. Idempotent: the success path
          // above already removed it, and a missing file is a no-op. A
          // budget-paused item is the exception — it goes back on the queue,
          // so its disk mirror must survive to be re-drained later.
          if (!budgetPaused) this.persistence?.remove(head.queueId);
        }
        if (budgetPaused) {
          // Put the head back and stop draining. The process-wide cost budget
          // only un-exhausts on a restart, so a later drain would just pause
          // here again; leave the whole queue — and its disk mirror — intact
          // for that restart to resume.
          this.q.unshift(head);
          log.warn('drain paused: process-wide cost budget exhausted');
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Re-admit queued runs recovered from disk after a restart. Unlike
   * `enqueue()`, this preserves each item's original `queueId` (the persisted
   * file is named by it, and a fresh id would orphan that file), does NOT
   * re-persist (the file already exists), and does NOT enforce `maxQueue` —
   * these runs were accepted before the restart, so dropping them would
   * re-introduce the very loss this persistence layer closes. A consequence:
   * a restored queue can sit above `maxQueue`, and new `enqueue()` calls then
   * shed with QUEUE_FULL until the drain brings it back under cap — restored
   * work is deliberately prioritized over new arrivals.
   *
   * Items are ordered by `receivedAt` so the post-restart drain stays FIFO at
   * millisecond granularity (same-millisecond arrivals may reorder relative
   * to each other — an acceptable bound). Re-emits `trigger_enqueued` so the
   * in-memory queue history, which does not survive a restart, is repopulated.
   *
   * Intended as a boot-time, empty-queue operation (crash-recovery calls it
   * once, before the server accepts requests). It pushes items as-is and does
   * not dedupe against `queueId`s already present, so calling it on a live,
   * non-empty queue could admit duplicates.
   */
  restore(items: QueuedRun[]): void {
    const ordered = [...items].sort(
      (a, b) => a.receivedAt - b.receivedAt || a.queueId.localeCompare(b.queueId),
    );
    for (const item of ordered) {
      this.q.push(item);
      eventBus.emit({
        type: 'trigger_enqueued',
        queueId: item.queueId,
        triggerId: item.triggerId,
        workflowId: item.workflow.id,
        correlationId: item.correlationId,
        inputs: item.resolvedInputs,
        position: this.q.length,
        receivedAt: item.receivedAt,
      });
    }
  }

  clear(): void {
    for (const item of this.q) this.persistence?.remove(item.queueId);
    this.q = [];
    this.draining = false;
  }
}
