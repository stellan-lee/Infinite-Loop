import type { Workflow } from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';
import { eventBus } from './event-bus';
import { createLogger } from './logger';

const log = createLogger('trigger-queue');

export interface QueuedRun {
  queueId: string;
  workflow: Workflow;
  resolvedInputs: ResolvedInputs;
  triggerId: string;
  receivedAt: number;
}

export interface TriggerQueueDeps {
  /** Returns the new run's id on success. Throws if the engine is busy. */
  engineStart: (wf: Workflow, opts: { resolvedInputs: ResolvedInputs }) => Promise<string>;
  /** Re-fetch the freshest workflow JSON by id. Used to detect deletions. */
  loadWorkflow: (id: string) => Promise<Workflow>;
  /** Called after a successful engine start to record the fire time on the
   *  persisted trigger. Optional for tests that don't care. */
  touchLastFired?: (triggerId: string) => Promise<void>;
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
  private maxQueue: number;

  constructor(deps: TriggerQueueDeps) {
    this.engineStart = deps.engineStart;
    this.loadWorkflow = deps.loadWorkflow;
    this.touchLastFired = deps.touchLastFired;
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
    eventBus.emit({
      type: 'trigger_removed',
      queueId: item.queueId,
      triggerId: item.triggerId,
      workflowId: item.workflow.id,
      reason: 'user-cancelled',
    });
    return { removed: true };
  }

  enqueue(item: Omit<QueuedRun, 'queueId'>): { queueId: string; position: number } {
    if (this.q.length >= this.maxQueue) {
      const err = new Error('trigger queue is full');
      (err as Error & { code?: string }).code = 'QUEUE_FULL';
      throw err;
    }
    const queueId = `q-${Date.now()}-${++this.nextId}`;
    const full: QueuedRun = { queueId, ...item };
    this.q.push(full);
    const position = this.q.length;
    eventBus.emit({
      type: 'trigger_enqueued',
      queueId,
      triggerId: full.triggerId,
      workflowId: full.workflow.id,
      inputs: full.resolvedInputs,
      position,
      receivedAt: full.receivedAt,
    });
    return { queueId, position };
  }

  /** Pull the head item and try to start it. If the engine is busy, re-prepend
   *  and bail. Continues until the queue is empty or the engine refuses. */
  async drain(): Promise<void> {
    if (this.draining) return;
    if (this.q.length === 0) return;
    this.draining = true;
    try {
      while (this.q.length > 0) {
        const head = this.q.shift()!;

        let workflow: Workflow;
        try {
          workflow = await this.loadWorkflow(head.workflow.id);
        } catch {
          eventBus.emit({
            type: 'trigger_dropped',
            queueId: head.queueId,
            triggerId: head.triggerId,
            reason: 'workflow-deleted',
          });
          continue;
        }

        try {
          const runId = await this.engineStart(workflow, {
            resolvedInputs: head.resolvedInputs,
          });
          eventBus.emit({
            type: 'trigger_started',
            queueId: head.queueId,
            triggerId: head.triggerId,
            workflowId: workflow.id,
            runId,
          });
          if (this.touchLastFired) {
            try { await this.touchLastFired(head.triggerId); }
            catch (err) { log.error('touchLastFired failed', { err }); }
          }
        } catch (err) {
          eventBus.emit({
            type: 'trigger_dropped',
            queueId: head.queueId,
            triggerId: head.triggerId,
            reason: 'engine-start-failed',
          });
          log.error('engineStart failed', { err });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  clear(): void {
    this.q = [];
    this.draining = false;
  }
}
