import { describe, expect, test } from 'bun:test';
import { SlotPool } from './slot-pool';

describe('SlotPool', () => {
  test('cap=2, third folder-touching run waits until one settles', async () => {
    const p = new SlotPool({ capacity: 2 });
    const a = await p.acquireForRun({ runId: 'a', nodeId: 'n1' });
    const b = await p.acquireForRun({ runId: 'b', nodeId: 'n1' });
    expect(p.size()).toBe(2);

    let cResolved = false;
    const cP = p.acquireForRun({ runId: 'c', nodeId: 'n1' }).then((h) => {
      cResolved = true;
      return h;
    });
    // Microtask flush: c should NOT have resolved yet.
    await Promise.resolve();
    expect(cResolved).toBe(false);
    expect(p.waiterCount()).toBe(1);

    a.release();
    const c = await cP;
    expect(cResolved).toBe(true);
    expect(p.size()).toBe(2); // b + c
    b.release();
    c.release();
    expect(p.size()).toBe(0);
  });

  test('cap=N, only N+1th waits', async () => {
    const p = new SlotPool({ capacity: 3 });
    await p.acquireForRun({ runId: 'a', nodeId: 'n' });
    await p.acquireForRun({ runId: 'b', nodeId: 'n' });
    await p.acquireForRun({ runId: 'c', nodeId: 'n' });
    let dResolved = false;
    void p.acquireForRun({ runId: 'd', nodeId: 'n' }).then(() => { dResolved = true; });
    await Promise.resolve();
    expect(dResolved).toBe(false);
    expect(p.waiterCount()).toBe(1);
  });

  test('folder-free runs (never call acquire) are unaffected', () => {
    const p = new SlotPool({ capacity: 1 });
    // No acquire calls — pool stays empty.
    expect(p.size()).toBe(0);
    expect(p.waiterCount()).toBe(0);
    expect(p.hasSlot('any-run')).toBe(false);
  });

  test('slot released once per run, even if acquire called multiple times', async () => {
    const p = new SlotPool({ capacity: 2 });
    const h1 = await p.acquireForRun({ runId: 'a', nodeId: 'n1' });
    const h2 = await p.acquireForRun({ runId: 'a', nodeId: 'n2' });
    // Same run, re-entry returns the same handle.
    expect(h1).toBe(h2);
    expect(p.size()).toBe(1);

    // release is idempotent
    h1.release();
    h1.release();
    h2.release();
    expect(p.size()).toBe(0);
  });

  test('slot waiter cancellable via abort signal; no slot consumed', async () => {
    const p = new SlotPool({ capacity: 1 });
    await p.acquireForRun({ runId: 'a', nodeId: 'n' });
    expect(p.size()).toBe(1);

    const ctrl = new AbortController();
    const bP = p.acquireForRun({ runId: 'b', nodeId: 'n', signal: ctrl.signal });
    await Promise.resolve();
    expect(p.waiterCount()).toBe(1);
    ctrl.abort();
    await expect(bP).rejects.toThrow(/aborted/);
    expect(p.waiterCount()).toBe(0);
    expect(p.hasSlot('b')).toBe(false);
  });

  test('setCapacity raise drains waiters immediately', async () => {
    const p = new SlotPool({ capacity: 1 });
    await p.acquireForRun({ runId: 'a', nodeId: 'n' });
    let bResolved = false;
    const bP = p.acquireForRun({ runId: 'b', nodeId: 'n' }).then((h) => { bResolved = true; return h; });
    let cResolved = false;
    const cP = p.acquireForRun({ runId: 'c', nodeId: 'n' }).then((h) => { cResolved = true; return h; });
    await Promise.resolve();
    expect(bResolved).toBe(false);
    expect(cResolved).toBe(false);

    p.setCapacity(3);
    await bP; await cP;
    expect(bResolved).toBe(true);
    expect(cResolved).toBe(true);
    expect(p.size()).toBe(3);
  });

  test('setCapacity lower does not preempt; new waiters honor lowered cap', async () => {
    const p = new SlotPool({ capacity: 3 });
    const a = await p.acquireForRun({ runId: 'a', nodeId: 'n' });
    const b = await p.acquireForRun({ runId: 'b', nodeId: 'n' });
    const c = await p.acquireForRun({ runId: 'c', nodeId: 'n' });
    expect(p.size()).toBe(3);

    p.setCapacity(1);
    expect(p.size()).toBe(3); // not preempted

    // A new waiter must wait until enough holders release to come under 1.
    let dResolved = false;
    void p.acquireForRun({ runId: 'd', nodeId: 'n' }).then(() => { dResolved = true; });
    await Promise.resolve();
    expect(dResolved).toBe(false);

    a.release();
    await Promise.resolve();
    expect(dResolved).toBe(false); // size still 2, cap 1
    b.release();
    await Promise.resolve();
    expect(dResolved).toBe(false); // size still 1, cap 1, drain doesn't admit because >= cap
    c.release();
    // After c releases, size 0, drain admits d.
    await Promise.resolve();
    expect(dResolved).toBe(true);
  });

  test('parallel branches of one run share single wait', async () => {
    const p = new SlotPool({ capacity: 1 });
    await p.acquireForRun({ runId: 'a', nodeId: 'n' });
    // Run b's three sibling branches try to acquire simultaneously.
    const b1 = p.acquireForRun({ runId: 'b', nodeId: 'branch-1' });
    const b2 = p.acquireForRun({ runId: 'b', nodeId: 'branch-2' });
    const b3 = p.acquireForRun({ runId: 'b', nodeId: 'branch-3' });
    await Promise.resolve();
    // Only ONE waiter enqueued, not three.
    expect(p.waiterCount()).toBe(1);

    // Release a; all three b promises resolve to the same handle.
    p.releaseRun('a');
    const [h1, h2, h3] = await Promise.all([b1, b2, b3]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(p.size()).toBe(1);
  });

  test('releaseRun cancels a pending waiter cleanly', async () => {
    const p = new SlotPool({ capacity: 1 });
    await p.acquireForRun({ runId: 'a', nodeId: 'n' });
    const bP = p.acquireForRun({ runId: 'b', nodeId: 'n' });
    await Promise.resolve();
    expect(p.waiterCount()).toBe(1);
    p.releaseRun('b'); // simulates run-b settle while still waiting
    await expect(bP).rejects.toThrow(/cancelled/);
    expect(p.waiterCount()).toBe(0);
  });

  test('FIFO order under contention', async () => {
    const p = new SlotPool({ capacity: 1 });
    const order: string[] = [];
    const a = await p.acquireForRun({ runId: 'a', nodeId: 'n' });

    const bP = p.acquireForRun({ runId: 'b', nodeId: 'n' }).then((h) => { order.push('b'); return h; });
    const cP = p.acquireForRun({ runId: 'c', nodeId: 'n' }).then((h) => { order.push('c'); return h; });
    const dP = p.acquireForRun({ runId: 'd', nodeId: 'n' }).then((h) => { order.push('d'); return h; });

    a.release();
    const bH = await bP;
    bH.release();
    const cH = await cP;
    cH.release();
    const dH = await dP;
    dH.release();

    expect(order).toEqual(['b', 'c', 'd']);
  });
});
