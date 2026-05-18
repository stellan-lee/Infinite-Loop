import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DirLockManager, LockCycleError } from './dir-lock-manager';
import { eventBus } from './event-bus';
import type { WorkflowEvent } from '../shared/workflow';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `lockmgr-${prefix}-`));
}

describe('DirLockManager', () => {
  let mgr: DirLockManager;
  let cleanups: string[] = [];

  beforeEach(() => {
    mgr = new DirLockManager();
    cleanups = [];
  });

  afterEach(async () => {
    mgr.clear();
    for (const dir of cleanups) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('1. exact-path conflict serializes', async () => {
    const dir = await tmpDir('exact');
    cleanups.push(dir);
    const projectA = await fs.mkdtemp(path.join(dir, 'proj-')); // create a non-exempt dir
    // tmpdir is exempt, so build under a non-exempt root
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const projectB = await fs.mkdtemp(path.join(homeDir, 'lockmgr-exact-'));
    cleanups.push(projectB);

    const releaseA = await mgr.acquire({ path: projectB, runId: 'run-a', nodeId: 'n1' });

    let bAcquired = false;
    const bP = mgr
      .acquire({ path: projectB, runId: 'run-b', nodeId: 'n1' })
      .then((r) => { bAcquired = true; return r; });
    await new Promise((r) => setTimeout(r, 5));
    expect(bAcquired).toBe(false);
    expect(mgr.waiterCount()).toBe(1);

    releaseA();
    await new Promise((r) => setTimeout(r, 5));
    expect(bAcquired).toBe(true);
    (await bP)();
  });

  test('2. ancestor holder blocks descendant acquire', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const parent = await fs.mkdtemp(path.join(homeDir, 'lockmgr-anc-'));
    cleanups.push(parent);
    const child = await fs.mkdtemp(path.join(parent, 'kid-'));

    const releaseParent = await mgr.acquire({ path: parent, runId: 'run-a', nodeId: 'n1' });

    let acquired = false;
    void mgr.acquire({ path: child, runId: 'run-b', nodeId: 'n1' }).then(() => { acquired = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(acquired).toBe(false);

    releaseParent();
    await new Promise((r) => setTimeout(r, 5));
    expect(acquired).toBe(true);
  });

  test('3. descendant holder blocks ancestor acquire', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const parent = await fs.mkdtemp(path.join(homeDir, 'lockmgr-desc-'));
    cleanups.push(parent);
    const child = await fs.mkdtemp(path.join(parent, 'kid-'));

    const releaseChild = await mgr.acquire({ path: child, runId: 'run-a', nodeId: 'n1' });

    let acquired = false;
    void mgr.acquire({ path: parent, runId: 'run-b', nodeId: 'n1' }).then(() => { acquired = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(acquired).toBe(false);

    releaseChild();
    await new Promise((r) => setTimeout(r, 5));
    expect(acquired).toBe(true);
  });

  test('4. FIFO across multiple waiters', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-fifo-'));
    cleanups.push(dir);
    const order: string[] = [];

    const releaseA = await mgr.acquire({ path: dir, runId: 'a', nodeId: 'n' });
    const bP = mgr.acquire({ path: dir, runId: 'b', nodeId: 'n' }).then((r) => { order.push('b'); return r; });
    const cP = mgr.acquire({ path: dir, runId: 'c', nodeId: 'n' }).then((r) => { order.push('c'); return r; });
    const dP = mgr.acquire({ path: dir, runId: 'd', nodeId: 'n' }).then((r) => { order.push('d'); return r; });

    releaseA();
    const bR = await bP; bR();
    const cR = await cP; cR();
    const dR = await dP; dR();
    expect(order).toEqual(['b', 'c', 'd']);
  });

  test('5. abort-on-signal removes waiter cleanly', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-abort-'));
    cleanups.push(dir);
    await mgr.acquire({ path: dir, runId: 'a', nodeId: 'n' });
    const ctrl = new AbortController();
    const bP = mgr.acquire({ path: dir, runId: 'b', nodeId: 'n', signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.waiterCount()).toBe(1);
    ctrl.abort();
    await expect(bP).rejects.toThrow(/aborted/);
    expect(mgr.waiterCount()).toBe(0);

    // After abort, a fresh run can acquire after the original holder releases.
    // No state leakage.
  });

  test('6. cycle rejection: A holds /a waits /b, B holds /b waits /a', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dirA = await fs.mkdtemp(path.join(homeDir, 'lockmgr-cyc-a-'));
    const dirB = await fs.mkdtemp(path.join(homeDir, 'lockmgr-cyc-b-'));
    cleanups.push(dirA, dirB);

    // A holds dirA, B holds dirB.
    await mgr.acquire({ path: dirA, runId: 'A', nodeId: 'na' });
    await mgr.acquire({ path: dirB, runId: 'B', nodeId: 'nb' });

    // A starts waiting for dirB (held by B). Edges: A → B.
    // Attach a .catch so the pending promise's eventual rejection during
    // mgr.clear() (afterEach) doesn't surface as an unhandled rejection.
    const aWantsB = mgr.acquire({ path: dirB, runId: 'A', nodeId: 'na2' });
    aWantsB.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));

    // B starts waiting for dirA (held by A). This would add edge B → A,
    // closing the cycle. The latecomer (B) should be rejected.
    await expect(
      mgr.acquire({ path: dirA, runId: 'B', nodeId: 'nb2' }),
    ).rejects.toThrow(LockCycleError);
  });

  test('7. sequential re-entry: same run, same path, after release', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-seq-'));
    cleanups.push(dir);
    const r1 = await mgr.acquire({ path: dir, runId: 'a', nodeId: 'n1' });
    r1();
    const r2 = await mgr.acquire({ path: dir, runId: 'a', nodeId: 'n2' });
    r2();
    expect(mgr.holderCount()).toBe(0);
  });

  test('8. parallel re-entry: same run, two simultaneous acquires of same path', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-par-'));
    cleanups.push(dir);
    const [r1, r2] = await Promise.all([
      mgr.acquire({ path: dir, runId: 'a', nodeId: 'branch-1' }),
      mgr.acquire({ path: dir, runId: 'a', nodeId: 'branch-2' }),
    ]);
    expect(mgr.holderCount()).toBe(1); // one entry, refcount=2
    r1();
    expect(mgr.holderCount()).toBe(1); // still held
    r2();
    expect(mgr.holderCount()).toBe(0); // fully freed
  });

  test('9. exempt path returns no-op release immediately', async () => {
    // /tmp is exempt. Two simultaneous acquires of /tmp by different runs
    // should both succeed without queuing.
    const a = await mgr.acquire({ path: '/tmp', runId: 'a', nodeId: 'n' });
    const b = await mgr.acquire({ path: '/tmp', runId: 'b', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(0); // no real holder recorded
    a(); b(); // no-op
  });

  test('10. registerExempt makes path no-op for the run', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-regex-'));
    cleanups.push(dir);
    const realDir = await fs.realpath(dir);
    mgr.registerExempt(realDir, 'run-a');

    // run-a's acquire is a no-op.
    const r = await mgr.acquire({ path: dir, runId: 'run-a', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(0);
    r();

    // run-b is NOT covered by run-a's exempt registration.
    const r2 = await mgr.acquire({ path: dir, runId: 'run-b', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(1);
    r2();

    mgr.releaseRun('run-a');
    // After releaseRun, run-a's exempt is gone — but run-a now hits real lock semantics.
    const r3 = await mgr.acquire({ path: dir, runId: 'run-a', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(1);
    r3();
  });

  test('11. macOS /tmp → /private/tmp canonicalization recognizes same key', async () => {
    // On macOS, fs.realpath('/tmp') returns '/private/tmp'.
    // The exempt list includes both '/tmp' and os.tmpdir() canonicalized.
    // Acquiring either path on either OS should hit the exempt branch.
    const a = await mgr.acquire({ path: '/tmp', runId: 'a', nodeId: 'n' });
    const b = await mgr.acquire({ path: os.tmpdir(), runId: 'b', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(0);
    a(); b();
  });

  test('12. ENOENT cwd: acquire fails fast', async () => {
    await expect(
      mgr.acquire({ path: '/tmp/definitely-does-not-exist-xyz-99999', runId: 'a', nodeId: 'n' }),
    ).rejects.toThrow(/non-existent/);
  });

  test('13. segment-wise prefix match: /x/.infloop-worktrees-fake is NOT exempt', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    // Create two directories whose names differ at the segment boundary.
    const fake = await fs.mkdtemp(path.join(homeDir, 'lockmgr-fake-'));
    cleanups.push(fake);
    // Register a worktree-like exempt path.
    const wtDir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-wt-'));
    cleanups.push(wtDir);
    const realWt = await fs.realpath(wtDir);
    mgr.registerExempt(realWt, 'run-a');

    // The fake dir is a sibling but its name shares no segment with the exempt.
    // run-a should still need a real lock on the fake dir.
    const r = await mgr.acquire({ path: fake, runId: 'run-a', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(1);
    r();

    // But a directory UNDER the exempt is exempt.
    const insideWt = await fs.mkdtemp(path.join(wtDir, 'inside-'));
    const r2 = await mgr.acquire({ path: insideWt, runId: 'run-a', nodeId: 'n' });
    expect(mgr.holderCount()).toBe(0);
    r2();
  });

  test('emits node_waiting_for_lock and node_lock_acquired events', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-ev-'));
    cleanups.push(dir);

    const events: WorkflowEvent[] = [];
    const unsub = eventBus.subscribe((e) => events.push(e));

    const a = await mgr.acquire({ path: dir, runId: 'a', nodeId: 'n1' });
    const bP = mgr.acquire({ path: dir, runId: 'b', nodeId: 'n2' });
    await new Promise((r) => setTimeout(r, 5));
    a();
    const bR = await bP;
    bR();
    unsub();

    const types = events.map((e) => e.type);
    expect(types).toContain('node_lock_acquired');
    expect(types).toContain('node_waiting_for_lock');
    const waitEv = events.find((e) => e.type === 'node_waiting_for_lock') as {
      runId?: string;
      heldByRunId: string;
      heldByPath: string;
    };
    expect(waitEv.runId).toBe('b');
    expect(waitEv.heldByRunId).toBe('a');
    expect(typeof waitEv.heldByPath).toBe('string');
    expect(waitEv.heldByPath.length).toBeGreaterThan(0);
  });

  test('release is idempotent', async () => {
    const homeDir = process.env.HOME ?? '/Users/liyuqi';
    const dir = await fs.mkdtemp(path.join(homeDir, 'lockmgr-idem-'));
    cleanups.push(dir);
    const release = await mgr.acquire({ path: dir, runId: 'a', nodeId: 'n' });
    release();
    release();
    release();
    expect(mgr.holderCount()).toBe(0);
  });
});
