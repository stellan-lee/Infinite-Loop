import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TriggerQueue } from './trigger-queue';
import type { Workflow } from '../shared/workflow';
import { eventBus } from './event-bus';
import type { WorkflowEvent } from '../shared/workflow';

function fakeWorkflow(id: string): Workflow {
  return {
    id, name: id, version: 1,
    createdAt: 0, updatedAt: 0,
    nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
    edges: [],
  };
}

describe('TriggerQueue', () => {
  let started: Array<{ workflowId: string; runId: string }>;
  let engineBusy: boolean;
  let nextRunId: number;
  let q: TriggerQueue;

  beforeEach(() => {
    started = [];
    engineBusy = false;
    nextRunId = 0;

    q = new TriggerQueue({
      engineStart: async (wf) => {
        if (engineBusy) {
          throw new Error('a run is already active');
        }
        const runId = `run-${++nextRunId}`;
        started.push({ workflowId: wf.id, runId });
        return runId;
      },
      loadWorkflow: async (id) => fakeWorkflow(id),
      maxQueue: 3,
    });
  });

  afterEach(() => q.clear());

  test('enqueue returns sequential positions', () => {
    const a = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    const b = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 2,
    });
    expect(a.position).toBe(1);
    expect(b.position).toBe(2);
    expect(a.queueId).not.toBe(b.queueId);
  });

  test('drain pulls and starts when engine is idle', async () => {
    q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    expect(started).toHaveLength(1);
    expect(q.size()).toBe(0);
  });

  test('drain emits trigger_dropped on engineStart failure', async () => {
    // Stage 5 removed the busy-error special-case from drain(). Any
    // engineStart rejection now drops the queued item with
    // reason 'engine-start-failed'.
    engineBusy = true;
    q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    expect(started).toHaveLength(0);
    expect(q.size()).toBe(0); // dropped, not re-prepended
  });

  test('enqueue throws when at cap', () => {
    for (let i = 0; i < 3; i++) {
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', receivedAt: i,
      });
    }
    expect(() =>
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', receivedAt: 99,
      }),
    ).toThrow(/queue.*full|cap/i);
  });

  test('FIFO order', async () => {
    q.enqueue({
      workflow: fakeWorkflow('a'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    q.enqueue({
      workflow: fakeWorkflow('b'), resolvedInputs: {},
      triggerId: 't', receivedAt: 2,
    });
    await q.drain();
    await q.drain();
    expect(started.map((s) => s.workflowId)).toEqual(['a', 'b']);
  });

  test('drain calls touchLastFired after a successful engine start', async () => {
    const touched: string[] = [];
    const q2 = new TriggerQueue({
      engineStart: async (wf) => `run-${wf.id}`,
      loadWorkflow: async (id) => fakeWorkflow(id),
      touchLastFired: async (id) => { touched.push(id); },
    });
    q2.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 'tid-XYZ', receivedAt: 1,
    });
    await q2.drain();
    expect(touched).toEqual(['tid-XYZ']);
  });

  test('removeByQueueId removes the matching item and emits trigger_removed', () => {
    const captured: WorkflowEvent[] = [];
    const unsub = eventBus.subscribe((e) => { captured.push(e); });
    try {
      const a = q.enqueue({
        workflow: fakeWorkflow('w1'), resolvedInputs: {},
        triggerId: 't1', receivedAt: 1,
      });
      const b = q.enqueue({
        workflow: fakeWorkflow('w2'), resolvedInputs: {},
        triggerId: 't2', receivedAt: 2,
      });

      const result = q.removeByQueueId(a.queueId);
      expect(result).toEqual({ removed: true });
      expect(q.list().map((i) => i.queueId)).toEqual([b.queueId]);

      const removed = captured.find((e) => e.type === 'trigger_removed');
      expect(removed).toEqual({
        type: 'trigger_removed',
        queueId: a.queueId,
        triggerId: 't1',
        workflowId: 'w1',
        reason: 'user-cancelled',
      });
    } finally {
      unsub();
    }
  });

  test('removeByQueueId on unknown id returns { removed: false } and emits nothing', () => {
    const captured: WorkflowEvent[] = [];
    const unsub = eventBus.subscribe((e) => { captured.push(e); });
    try {
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', receivedAt: 1,
      });
      const before = captured.length;

      const result = q.removeByQueueId('q-does-not-exist');
      expect(result).toEqual({ removed: false });
      expect(q.size()).toBe(1);
      expect(captured.length).toBe(before);
    } finally {
      unsub();
    }
  });

  test('drain skips an item that was removed before drain started', async () => {
    const a = q.enqueue({
      workflow: fakeWorkflow('w1'), resolvedInputs: {},
      triggerId: 't1', receivedAt: 1,
    });
    const b = q.enqueue({
      workflow: fakeWorkflow('w2'), resolvedInputs: {},
      triggerId: 't2', receivedAt: 2,
    });
    q.removeByQueueId(a.queueId);
    await q.drain();
    expect(started).toEqual([{ workflowId: 'w2', runId: 'run-1' }]);
    expect(q.size()).toBe(0);
  });

  test('list returns items in order as a copy', () => {
    const a = q.enqueue({
      workflow: fakeWorkflow('w1'), resolvedInputs: {},
      triggerId: 't1', receivedAt: 1,
    });
    const b = q.enqueue({
      workflow: fakeWorkflow('w2'), resolvedInputs: {},
      triggerId: 't2', receivedAt: 2,
    });

    const items = q.list();
    expect(items.map((i) => i.queueId)).toEqual([a.queueId, b.queueId]);
    expect(items.map((i) => i.workflow.id)).toEqual(['w1', 'w2']);

    // mutating the returned array must not affect internal state
    items.pop();
    expect(q.size()).toBe(2);
  });
});
