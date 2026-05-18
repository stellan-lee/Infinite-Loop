/*
 * DirLockManager — process-local directory lock for Agent CLI runs.
 *
 * Two runs whose Agent nodes share a `cwd` would race on filesystem and
 * git state. The lock serializes those runs against that shared resource.
 * Acquired inside the agent executor only for CLI transport; HTTP-transport
 * agents skip entirely.
 *
 * Key properties (see docs/concurrent-runs.md for the full spec):
 *
 * - Key = canonicalized absolute path (`fs.realpath` resolves symlinks; on
 *   macOS `/tmp` → `/private/tmp`). ENOENT during canonicalization fails
 *   the acquire fast — workflows that need to create a directory must do
 *   so in an upstream node.
 *
 * - Conflict = exact match OR ancestor OR descendant of any currently-held
 *   path, EXCEPT when the would-be acquirer is the same run as the holder
 *   (re-entry; refcount tracks sibling parallel branches inside one run).
 *
 * - Exempt prefixes (`/tmp`, `os.tmpdir()`, plus env-configurable extras,
 *   plus any path registered via `registerExempt`) return a no-op release
 *   immediately. Worktree paths are registered explicitly by
 *   RunWorktreesImpl rather than relying on a `.infloop-worktrees/`
 *   substring heuristic.
 *
 * - FIFO wait queue per conflicting subtree, with abort-on-cancel.
 *
 * - Wait-for graph detects cycles among path-lock waits. Slot waits are
 *   pure FIFO and do not contribute edges (a slot waiter holds no path
 *   locks by construction; no cycle can include it).
 *
 * - Returned release function is idempotent: a second call is a no-op so
 *   defensive try/finally double-release patterns are safe.
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { eventBus } from './event-bus';
import type { SlotPool } from './slot-pool';

export class LockCycleError extends Error {
  readonly cycle: string[];
  readonly resource: { kind: 'lock'; path: string };
  constructor(cycle: string[], lockedPath: string) {
    super(
      `directory lock cycle detected: ${cycle.join(' → ')} (path "${lockedPath}")`,
    );
    this.name = 'LockCycleError';
    this.cycle = cycle;
    this.resource = { kind: 'lock', path: lockedPath };
  }
}

export interface AcquireOpts {
  path: string;
  runId: string;
  nodeId: string;
  signal?: AbortSignal;
}

/**
 * Hook a RunController gives the lock manager so it can mutate the run's
 * snapshot when a node parks on a lock or slot. One-way dependency: the
 * lock manager calls into the observer; the observer never reaches back.
 */
export interface LockWaitObserver {
  onLockWaitStart(
    nodeId: string,
    path: string,
    heldByRunId: string,
    heldByPath: string,
  ): void;
  onLockWaitEnd(nodeId: string): void;
  onSlotWaitStart(nodeId: string): void;
  onSlotWaitEnd(nodeId: string): void;
}

interface HolderEntry {
  canonicalPath: string;
  /** runId → number of times the run has acquired this path (parallel
   *  siblings within one run all increment; release decrements). The path
   *  is fully freed only when this map is empty. */
  refCountByRun: Map<string, number>;
}

interface Waiter {
  canonicalPath: string;
  runId: string;
  nodeId: string;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  /** Wait-for-graph edges this waiter contributed. Per-waiter so that one
   *  branch's abort/promotion in a multi-branch run doesn't wipe sibling
   *  edges (which would mask a real cycle the siblings still participate
   *  in). */
  edgeTargets: Set<string>;
}

interface ExemptRegistration {
  /** Canonicalized absolute path. Compared segment-wise to acquire keys. */
  canonicalPath: string;
  runId: string;
}

export class DirLockManager {
  /** Static exempt prefixes from env + defaults, canonicalized. Lazy. */
  private envExemptCache?: string[];
  /** Per-run registered exempt paths (worktrees). Cleared on `releaseRun`. */
  private runExempts = new Map<string, Set<string>>();

  private holders: HolderEntry[] = [];
  private waiters: Waiter[] = [];

  /** Optional slot pool: when present, every non-exempt acquire ensures the
   *  run holds a slot before attempting the path lock (lazy admission). */
  private slotPool?: SlotPool;

  /** Per-run observers — the RunController registers one so its snapshot's
   *  `waitingFor` field can be mutated when this run parks on a lock/slot
   *  and cleared when the wait resolves. The lock manager does not know
   *  about controllers directly; observers keep the dependency one-way. */
  private observers = new Map<string, LockWaitObserver>();

  constructor(deps?: { slotPool?: SlotPool }) {
    this.slotPool = deps?.slotPool;
  }

  /** Register an observer for run `runId`. Called by the RunController on
   *  start; unregistered on settle via `releaseRun`. */
  registerObserver(runId: string, observer: LockWaitObserver): void {
    this.observers.set(runId, observer);
  }

  /**
   * Wait-for graph for path-lock waits. Edge `A → B` means "run A is
   * waiting on a path held by run B". On enqueue, a cycle from the waiter
   * back to itself rejects the acquire with `LockCycleError`.
   */
  private waitForEdges = new Map<string, Set<string>>();

  /**
   * Register `path` as exempt for the lifetime of `runId`. The path must
   * already be a canonical absolute path; callers (e.g. RunWorktreesImpl)
   * receive canonical paths from `fs.realpath`. Returns a deregister fn
   * for early release; otherwise `releaseRun(runId)` clears all of a run's
   * registrations together.
   */
  registerExempt(canonicalPath: string, runId: string): () => void {
    let set = this.runExempts.get(runId);
    if (!set) {
      set = new Set();
      this.runExempts.set(runId, set);
    }
    set.add(canonicalPath);
    return () => {
      const s = this.runExempts.get(runId);
      if (s) {
        s.delete(canonicalPath);
        if (s.size === 0) this.runExempts.delete(runId);
      }
    };
  }

  /**
   * Clear all of a run's exempt registrations and observer. Called by the
   * engine in the run's settle path.
   */
  releaseRun(runId: string): void {
    this.runExempts.delete(runId);
    this.observers.delete(runId);
  }

  /**
   * Acquire a lock on `opts.path` for `opts.runId`/`opts.nodeId`. Resolves
   * to an idempotent release fn. Conflicts (ancestor/descendant of a held
   * path held by a DIFFERENT run) queue FIFO; same-run re-entry returns
   * immediately and increments the refcount.
   *
   * Canonicalization is synchronous (`realpathSync`). Doing it async would
   * insert an await between `acquire()` being called and the waiter being
   * enqueued, which breaks FIFO order when callers fire multiple acquires
   * in sequence (the second caller's canonicalize could resolve before the
   * first, swapping their queue positions).
   */
  acquire(opts: AcquireOpts): Promise<() => void> {
    let canonical: string;
    try {
      canonical = this.canonicalize(opts.path);
    } catch (err) {
      return Promise.reject(err);
    }

    if (this.isExempt(canonical, opts.runId)) {
      return Promise.resolve(makeIdempotent(() => undefined));
    }

    if (opts.signal?.aborted) {
      return Promise.reject(new Error('acquire aborted'));
    }

    // Lazy slot admission. Non-exempt acquires gate on the slot pool first;
    // exempt acquires above never reach here. Same-run re-entry hits
    // `hasSlot(runId) === true` and skips the wait.
    if (this.slotPool && !this.slotPool.hasSlot(opts.runId)) {
      return this.acquireSlotThenLock(canonical, opts);
    }

    return this.acquireLockOnly(canonical, opts);
  }

  /**
   * Slot fast/slow path: wait for a slot if needed (with waiting/acquired
   * events), then proceed to the path lock. Cancellation propagates.
   */
  private async acquireSlotThenLock(
    canonical: string,
    opts: AcquireOpts,
  ): Promise<() => void> {
    if (!this.slotPool) {
      throw new Error('acquireSlotThenLock called with no slot pool');
    }
    // Emit only when we'd actually wait — capacity reads are cheap and
    // avoid event noise on the common fast path.
    const willWait = this.slotPool.size() >= this.slotPool.getCapacity();
    if (willWait) {
      eventBus.emit({
        type: 'node_waiting_for_slot',
        runId: opts.runId,
        nodeId: opts.nodeId,
      });
      this.observers.get(opts.runId)?.onSlotWaitStart(opts.nodeId);
    }
    try {
      await this.slotPool.acquireForRun({
        runId: opts.runId,
        nodeId: opts.nodeId,
        signal: opts.signal,
      });
    } finally {
      if (willWait) {
        this.observers.get(opts.runId)?.onSlotWaitEnd(opts.nodeId);
      }
    }
    if (willWait) {
      eventBus.emit({
        type: 'node_slot_acquired',
        runId: opts.runId,
        nodeId: opts.nodeId,
      });
    }
    return this.acquireLockOnly(canonical, opts);
  }

  /**
   * Path-lock logic, with slot already held (or no slot pool). Pure sync up
   * to the wait-promise creation so FIFO ordering is preserved when callers
   * fire multiple acquires in a row.
   */
  private acquireLockOnly(
    canonical: string,
    opts: AcquireOpts,
  ): Promise<() => void> {
    // Try synchronous acquire (no conflict, OR same-run re-entry).
    const sync = this.tryAcquireSync(canonical, opts.runId);
    if (sync.ok) {
      this.emitLockAcquired(opts.runId, opts.nodeId, canonical);
      return Promise.resolve(makeIdempotent(() => this.release(canonical, opts.runId)));
    }

    // Cycle check before enqueuing.
    const holderRunIds = sync.heldByRunIds!;
    for (const heldBy of holderRunIds) {
      if (this.wouldCreateCycle(opts.runId, heldBy)) {
        const cyclePath = this.tracePath(heldBy, opts.runId);
        return Promise.reject(
          new LockCycleError([opts.runId, ...cyclePath], canonical),
        );
      }
    }

    const heldByEntry = sync.heldBy!;
    const firstHolderRunId = holderRunIds[0];
    this.emitWaitingForLock(
      opts.runId,
      opts.nodeId,
      canonical,
      firstHolderRunId,
      heldByEntry.canonicalPath,
    );
    const edgeTargets = new Set<string>();
    for (const heldBy of holderRunIds) {
      this.addEdge(opts.runId, heldBy);
      edgeTargets.add(heldBy);
    }
    this.observers
      .get(opts.runId)
      ?.onLockWaitStart(opts.nodeId, canonical, firstHolderRunId, heldByEntry.canonicalPath);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        canonicalPath: canonical,
        runId: opts.runId,
        nodeId: opts.nodeId,
        resolve: (release) => {
          this.emitLockAcquired(opts.runId, opts.nodeId, canonical);
          resolve(release);
        },
        reject,
        signal: opts.signal,
        edgeTargets,
      };
      if (opts.signal) {
        const listener = () => this.removeWaiter(waiter, new Error('acquire aborted'));
        waiter.abortListener = listener;
        opts.signal.addEventListener('abort', listener, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /* ─── internals ─────────────────────────────────────────────────────────── */

  private canonicalize(p: string): string {
    if (!p) {
      throw new Error('cannot lock empty path');
    }
    const abs = path.resolve(p);
    try {
      const real = realpathSync(abs);
      return stripTrailing(real);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`cannot lock non-existent path: ${p}`);
      }
      throw err;
    }
  }

  private isExempt(canonical: string, runId: string): boolean {
    // Per-run registrations (e.g. worktrees).
    const set = this.runExempts.get(runId);
    if (set) {
      for (const exempt of set) {
        if (canonical === exempt || isUnderSegment(canonical, exempt)) {
          return true;
        }
      }
    }
    // Static prefixes.
    for (const exempt of this.envExempts()) {
      if (canonical === exempt || isUnderSegment(canonical, exempt)) {
        return true;
      }
    }
    return false;
  }

  private envExempts(): string[] {
    if (this.envExemptCache) return this.envExemptCache;
    const raw: string[] = ['/tmp', os.tmpdir()];
    const env = process.env.INFLOOP_LOCK_EXEMPT_PREFIXES;
    if (env) {
      for (const part of env.split(':')) {
        const t = part.trim();
        if (t) raw.push(t);
      }
    }
    // Best-effort canonicalize; if a configured path doesn't exist we keep
    // the resolved-absolute form so the segment match still works against
    // any future descendants that DO get canonicalized.
    const out: string[] = [];
    for (const r of raw) {
      const abs = path.resolve(r);
      try {
        out.push(stripTrailing(realpathSync(abs)));
      } catch {
        out.push(stripTrailing(abs));
      }
    }
    this.envExemptCache = out;
    return out;
  }

  private tryAcquireSync(
    canonical: string,
    runId: string,
  ): { ok: true } | { ok: false; heldBy: HolderEntry; heldByRunIds: string[] } {
    // Find any conflicting entry: same path, ancestor, or descendant.
    for (const h of this.holders) {
      if (pathsOverlap(canonical, h.canonicalPath)) {
        // Same-run re-entry → increment.
        if (h.refCountByRun.has(runId)) {
          h.refCountByRun.set(runId, h.refCountByRun.get(runId)! + 1);
          return { ok: true };
        }
        // Conflict.
        return {
          ok: false,
          heldBy: h,
          heldByRunIds: [...h.refCountByRun.keys()],
        };
      }
    }
    // Free → register this run as the holder.
    const entry: HolderEntry = {
      canonicalPath: canonical,
      refCountByRun: new Map([[runId, 1]]),
    };
    this.holders.push(entry);
    return { ok: true };
  }

  private release(canonical: string, runId: string): void {
    const idx = this.holders.findIndex((h) => h.canonicalPath === canonical);
    if (idx === -1) return; // already fully released
    const entry = this.holders[idx];
    const cur = entry.refCountByRun.get(runId);
    if (cur === undefined) return;
    if (cur > 1) {
      entry.refCountByRun.set(runId, cur - 1);
      return;
    }
    entry.refCountByRun.delete(runId);
    if (entry.refCountByRun.size === 0) {
      this.holders.splice(idx, 1);
      this.promoteWaiters();
    }
  }

  /**
   * After a release, try to admit the next waiters in FIFO order. We try
   * each waiter in order; a waiter that can acquire (synchronously) is
   * promoted and its release fn is delivered. Order matters: a waiter on
   * a path that's still conflicted by a remaining holder must NOT block
   * waiters behind it whose paths are free. To preserve fairness without
   * making this expensive, we promote in FIFO order and stop at the first
   * waiter whose path is still conflicted by a holder that does not
   * overlap any earlier waiter in the queue — but to keep things simple,
   * we just sweep the queue once per promote call. Anything not promoted
   * stays.
   */
  private promoteWaiters(): void {
    let i = 0;
    while (i < this.waiters.length) {
      const w = this.waiters[i];
      const sync = this.tryAcquireSync(w.canonicalPath, w.runId);
      if (sync.ok) {
        // Promote: remove this waiter only and just its edges, so sibling
        // waiters of the same run keep their wait-for-graph contributions.
        this.waiters.splice(i, 1);
        this.removeWaiterEdges(w);
        if (w.signal && w.abortListener) {
          w.signal.removeEventListener('abort', w.abortListener);
        }
        this.observers.get(w.runId)?.onLockWaitEnd(w.nodeId);
        w.resolve(makeIdempotent(() => this.release(w.canonicalPath, w.runId)));
        continue; // index now points at next waiter
      }
      i++;
    }
  }

  private removeWaiter(target: Waiter, err: Error): void {
    const idx = this.waiters.indexOf(target);
    if (idx === -1) return;
    this.waiters.splice(idx, 1);
    if (target.signal && target.abortListener) {
      target.signal.removeEventListener('abort', target.abortListener);
    }
    this.removeWaiterEdges(target);
    this.observers.get(target.runId)?.onLockWaitEnd(target.nodeId);
    target.reject(err);
  }

  /**
   * Subtract only this waiter's edge contributions from the wait-for graph.
   * Each waiter recorded its targets at enqueue time; sibling waiters of
   * the same run keep theirs intact.
   */
  private removeWaiterEdges(w: Waiter): void {
    const outs = this.waitForEdges.get(w.runId);
    if (!outs) return;
    for (const t of w.edgeTargets) {
      // A target is only safe to remove if no OTHER waiter from this run
      // still depends on it. Sweep the queue to verify.
      let stillNeeded = false;
      for (const other of this.waiters) {
        if (other.runId === w.runId && other.edgeTargets.has(t)) {
          stillNeeded = true;
          break;
        }
      }
      if (!stillNeeded) outs.delete(t);
    }
    if (outs.size === 0) this.waitForEdges.delete(w.runId);
  }

  /* ─── wait-for graph ────────────────────────────────────────────────────── */

  private addEdge(from: string, to: string): void {
    let set = this.waitForEdges.get(from);
    if (!set) {
      set = new Set();
      this.waitForEdges.set(from, set);
    }
    set.add(to);
  }

  private wouldCreateCycle(from: string, to: string): boolean {
    if (from === to) return true; // self-edge is a cycle
    // Hypothetical: from → to. Does `to` already transitively reach `from`?
    const visited = new Set<string>();
    const stack = [to];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === from) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      const outs = this.waitForEdges.get(node);
      if (outs) {
        for (const next of outs) stack.push(next);
      }
    }
    return false;
  }

  private tracePath(from: string, to: string): string[] {
    // BFS for a shortest path from → to. Used only on cycle detection so
    // the error message names the offending chain. Caller has just confirmed
    // a path exists via wouldCreateCycle, so the BFS always finds one — no
    // fallback needed.
    const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];
    const seen = new Set<string>([from]);
    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (id === to) return path;
      const outs = this.waitForEdges.get(id);
      if (outs) {
        for (const next of outs) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push({ id: next, path: [...path, next] });
        }
      }
    }
    // Unreachable per the precondition; if it ever fires, the wait-for graph
    // mutated between cycle-detection and trace, which would be a bug.
    throw new Error('tracePath: graph mutated unexpectedly');
  }

  /* ─── events ────────────────────────────────────────────────────────────── */

  // These are emitted directly via eventBus rather than through
  // controller.emit because the lock manager is not aware of the controller.
  // The controller is the only thing that knows runId-to-controller mapping;
  // future stages may pass the emit-stamping fn down so events automatically
  // carry runId. For now, the runId is included in the payload explicitly.

  private emitWaitingForLock(
    runId: string,
    nodeId: string,
    canonicalPath: string,
    heldByRunId: string,
    heldByCanonicalPath: string,
  ): void {
    // The holder's nodeId is not tracked here — within a run, a sibling
    // parallel branch could be the actual holder and the lock manager
    // doesn't know which one. The runId + paths are the share key.
    eventBus.emit({
      type: 'node_waiting_for_lock',
      runId,
      nodeId,
      path: canonicalPath,
      heldByRunId,
      heldByPath: heldByCanonicalPath,
    });
  }

  private emitLockAcquired(runId: string, nodeId: string, canonicalPath: string): void {
    eventBus.emit({
      type: 'node_lock_acquired',
      runId,
      nodeId,
      path: canonicalPath,
    });
  }

  /* ─── test helpers ──────────────────────────────────────────────────────── */

  /** Number of currently-held lock entries. */
  holderCount(): number {
    return this.holders.length;
  }

  /** Number of currently-waiting acquirers. */
  waiterCount(): number {
    return this.waiters.length;
  }

  /** Clear all state. Tests only. */
  clear(): void {
    for (const w of this.waiters) {
      if (w.signal && w.abortListener) {
        w.signal.removeEventListener('abort', w.abortListener);
      }
      w.reject(new Error('lock manager cleared'));
    }
    this.waiters = [];
    this.holders = [];
    this.waitForEdges.clear();
    this.runExempts.clear();
    this.envExemptCache = undefined;
  }
}

/* ─── helpers ────────────────────────────────────────────────────────────── */

function makeIdempotent(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function stripTrailing(p: string): string {
  if (p.length > 1 && p.endsWith(path.sep)) return p.slice(0, -1);
  return p;
}

/** True when `a` is the same path as `b`, or an ancestor of `b`, or a
 *  descendant of `b`. Uses segment boundaries to avoid false positives
 *  like `/a/foo` matching `/a/foo-bar`. */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return isUnderSegment(a, b) || isUnderSegment(b, a);
}

/** True when `child` is strictly under `parent`, comparing segment by
 *  segment (not by substring). `/a/b/c` is under `/a/b`; `/a/b-c` is NOT. */
function isUnderSegment(child: string, parent: string): boolean {
  if (child.length <= parent.length) return false;
  if (!child.startsWith(parent)) return false;
  return child[parent.length] === path.sep;
}
