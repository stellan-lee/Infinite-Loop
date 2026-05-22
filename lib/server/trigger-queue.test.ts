import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TriggerQueue, type QueuedRun } from './trigger-queue';
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

  test('enqueue mints a correlation id when the caller omits one', () => {
    const r = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    expect(r.correlationId).toMatch(/^cid_/);
    expect(q.list()[0].correlationId).toBe(r.correlationId);
  });

  test('enqueue preserves a caller-supplied correlation id', () => {
    const r = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', correlationId: 'cid-supplied', receivedAt: 1,
    });
    expect(r.correlationId).toBe('cid-supplied');
    expect(q.list()[0].correlationId).toBe('cid-supplied');
  });

  test('the correlation id rides queue events through enqueue → start', async () => {
    const captured: WorkflowEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e));
    try {
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', correlationId: 'cid-trace', receivedAt: 1,
      });
      await q.drain();
      const enq = captured.find((e) => e.type === 'trigger_enqueued');
      const started = captured.find((e) => e.type === 'trigger_started');
      expect(enq?.correlationId).toBe('cid-trace');
      expect(started?.correlationId).toBe('cid-trace');
    } finally {
      unsub();
    }
  });

  test('a dropped run still carries the correlation id', async () => {
    engineBusy = true;
    const captured: WorkflowEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e));
    try {
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', correlationId: 'cid-drop', receivedAt: 1,
      });
      await q.drain();
      const dropped = captured.find((e) => e.type === 'trigger_dropped');
      expect(dropped?.correlationId).toBe('cid-drop');
    } finally {
      unsub();
    }
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
    // Stage 5 removed the busy-error special-case from drain(). A generic
    // engineStart rejection now drops the queued item with reason
    // 'engine-start-failed' — the COST_BUDGET_EXCEEDED rejection is the one
    // exception (see the budget-pause test above).
    engineBusy = true;
    q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    expect(started).toHaveLength(0);
    expect(q.size()).toBe(0); // dropped, not re-prepended
  });

  test('drain pauses and re-queues the head when the cost budget is exhausted', async () => {
    // engineStart throws the COST_BUDGET_EXCEEDED code that engineStartAdapter
    // raises once the process-wide cost budget is spent.
    const budgetErr: Error & { code?: string } = new Error('budget exhausted');
    budgetErr.code = 'COST_BUDGET_EXCEEDED';
    const paused = new TriggerQueue({
      engineStart: async () => {
        throw budgetErr;
      },
      loadWorkflow: async (id) => fakeWorkflow(id),
    });
    paused.enqueue({
      workflow: fakeWorkflow('a'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    paused.enqueue({
      workflow: fakeWorkflow('b'), resolvedInputs: {},
      triggerId: 't', receivedAt: 2,
    });
    await paused.drain();
    // Nothing started, and BOTH items are still queued in their original
    // order — a budget refusal pauses the drain, it does not drop the queue.
    expect(paused.list().map((i) => i.workflow.id)).toEqual(['a', 'b']);
    paused.clear();
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

  test('enqueue at cap emits trigger_dropped{reason:queue-full}', () => {
    // Regression: the queue-full shed must emit `trigger_dropped` so
    // `infloop_queue_dropped_total{reason="queue-full"}` increments and
    // `InfiniteLoopTriggerQueueDropping` can fire. The counter sat at 0
    // before this emit was wired (found by the production burn-in).
    for (let i = 0; i < 3; i++) {
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', receivedAt: i,
      });
    }
    const captured: WorkflowEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e));
    try {
      expect(() =>
        q.enqueue({
          workflow: fakeWorkflow('w'), resolvedInputs: {},
          triggerId: 't-rejected', correlationId: 'cid-full', receivedAt: 99,
        }),
      ).toThrow(/queue.*full|cap/i);
    } finally {
      unsub();
    }
    const dropped = captured.filter((e) => e.type === 'trigger_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      reason: 'queue-full',
      triggerId: 't-rejected',
      correlationId: 'cid-full',
    });
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
        correlationId: a.correlationId,
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

/* ─── persistence + restore (crash recovery) ─────────────────────────────── */

describe('TriggerQueue persistence', () => {
  function fakePersistence() {
    const added: QueuedRun[] = [];
    const removed: string[] = [];
    return {
      added,
      removed,
      impl: {
        add: (item: QueuedRun) => { added.push(item); },
        remove: (queueId: string) => { removed.push(queueId); },
      },
    };
  }

  test('enqueue persists the full item before returning', () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    const { queueId } = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: { a: '1' },
      triggerId: 't', receivedAt: 5,
    });
    expect(p.added).toHaveLength(1);
    expect(p.added[0].queueId).toBe(queueId);
    expect(p.added[0].triggerId).toBe('t');
    expect(p.added[0].resolvedInputs).toEqual({ a: '1' });
  });

  test('drain removes the persisted file after a successful start', async () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    const { queueId } = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    expect(p.removed).toContain(queueId);
  });

  test('drain removes the persisted file when engineStart fails', async () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => { throw new Error('boom'); },
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    const { queueId } = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    expect(p.removed).toContain(queueId);
  });

  test('drain removes the persisted file when the workflow was deleted', async () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async () => { throw new Error('not found'); },
      persistence: p.impl,
    });
    const { queueId } = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    expect(p.removed).toContain(queueId);
  });

  test('drain keeps the persisted file when the cost budget is exhausted', async () => {
    const p = fakePersistence();
    const budgetErr: Error & { code?: string } = new Error('budget exhausted');
    budgetErr.code = 'COST_BUDGET_EXCEEDED';
    const q = new TriggerQueue({
      engineStart: async () => {
        throw budgetErr;
      },
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    const { queueId } = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    await q.drain();
    // The item is re-queued, not dropped, so its disk mirror MUST survive —
    // a restart (which resets the budget) re-drains it.
    expect(p.removed).not.toContain(queueId);
    expect(q.size()).toBe(1);
    q.clear();
  });

  test('removeByQueueId removes the persisted file', () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    const { queueId } = q.enqueue({
      workflow: fakeWorkflow('w'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    q.removeByQueueId(queueId);
    expect(p.removed).toEqual([queueId]);
  });

  test('clear removes the persisted file for every queued item', () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    const a = q.enqueue({
      workflow: fakeWorkflow('w1'), resolvedInputs: {},
      triggerId: 't', receivedAt: 1,
    });
    const b = q.enqueue({
      workflow: fakeWorkflow('w2'), resolvedInputs: {},
      triggerId: 't', receivedAt: 2,
    });
    q.clear();
    expect(p.removed.sort()).toEqual([a.queueId, b.queueId].sort());
  });

  test('restore re-admits items preserving queueId, in receivedAt order', () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    // Deliberately out of receivedAt order.
    q.restore([
      { queueId: 'q-b', workflow: fakeWorkflow('w2'), resolvedInputs: {}, triggerId: 't2', correlationId: 'cid-b', receivedAt: 20 },
      { queueId: 'q-a', workflow: fakeWorkflow('w1'), resolvedInputs: {}, triggerId: 't1', correlationId: 'cid-a', receivedAt: 10 },
    ]);
    expect(q.list().map((i) => i.queueId)).toEqual(['q-a', 'q-b']);
    // restore must NOT re-persist — the files already exist on disk.
    expect(p.added).toHaveLength(0);
  });

  test('restore ignores the maxQueue cap', () => {
    const p = fakePersistence();
    const q = new TriggerQueue({
      engineStart: async () => 'run-1',
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
      maxQueue: 1,
    });
    q.restore([
      { queueId: 'q-1', workflow: fakeWorkflow('w'), resolvedInputs: {}, triggerId: 't', correlationId: 'cid-1', receivedAt: 1 },
      { queueId: 'q-2', workflow: fakeWorkflow('w'), resolvedInputs: {}, triggerId: 't', correlationId: 'cid-2', receivedAt: 2 },
      { queueId: 'q-3', workflow: fakeWorkflow('w'), resolvedInputs: {}, triggerId: 't', correlationId: 'cid-3', receivedAt: 3 },
    ]);
    expect(q.size()).toBe(3);
    // A new enqueue still honors the cap — restored work sheds new arrivals.
    expect(() =>
      q.enqueue({
        workflow: fakeWorkflow('w'), resolvedInputs: {},
        triggerId: 't', receivedAt: 4,
      }),
    ).toThrow(/queue.*full/i);
  });

  test('restored items drain and start in order', async () => {
    const p = fakePersistence();
    const started: string[] = [];
    const q = new TriggerQueue({
      engineStart: async (wf) => { started.push(wf.id); return `run-${wf.id}`; },
      loadWorkflow: async (id) => fakeWorkflow(id),
      persistence: p.impl,
    });
    q.restore([
      { queueId: 'q-2', workflow: fakeWorkflow('second'), resolvedInputs: {}, triggerId: 't', correlationId: 'cid-2', receivedAt: 2 },
      { queueId: 'q-1', workflow: fakeWorkflow('first'), resolvedInputs: {}, triggerId: 't', correlationId: 'cid-1', receivedAt: 1 },
    ]);
    await q.drain();
    expect(started).toEqual(['first', 'second']);
    // Both files are dropped. drain() removes a started item twice — once
    // early (right after engineStart) and once in the per-item finally — and
    // that is fine: removal is idempotent. Assert the set, not the count.
    expect([...new Set(p.removed)].sort()).toEqual(['q-1', 'q-2']);
  });
});
