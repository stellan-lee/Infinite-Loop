/*
 * SlotPool — bounded admission for runs that compete on the filesystem.
 *
 * Acquired LAZILY: a run does not consume a slot at start. The
 * DirLockManager calls `acquireForRun(...)` the first time a run requests a
 * non-exempt directory lock; once acquired, the slot is held for the rest
 * of the run's lifetime and released via `releaseRun(...)` when the
 * RunController settles. Folder-free runs (HTTP-transport agents, all-`/tmp`
 * cwds, all-worktree runs) never call into this pool.
 *
 * Within one run, the first parallel branch to hit acquire does the wait;
 * sibling acquires observe the cached promise and proceed without
 * re-entering the wait queue. The pool exposes a per-run `hasSlot` check so
 * the lock manager can implement this efficiently.
 *
 * Slot waits do NOT participate in the wait-for graph (see design doc REC-2):
 * a slot waiter, by construction, holds no path locks, so it cannot close a
 * cycle. Slot waits are pure FIFO.
 *
 * Capacity is reconfigurable at runtime via `setCapacity(n)`:
 *   - raising drains the FIFO wait queue up to the new cap immediately
 *   - lowering does not preempt current holders; new waiters honor the new
 *     cap as holders settle naturally
 */

export interface SlotHandle {
  /** Release this run's slot. Idempotent: a second call is a no-op. */
  release: () => void;
  acquiredAt: number;
}

interface Waiter {
  runId: string;
  nodeId: string;
  resolve: (handle: SlotHandle) => void;
  reject: (err: Error) => void;
  abortListener?: () => void;
  signal?: AbortSignal;
}

export class SlotPool {
  private capacity: number;
  /** runId → handle for runs currently holding a slot. */
  private holders = new Map<string, SlotHandle>();
  /** runId → pending acquire promise. Sibling acquires within the same run
   *  resolve through this single promise instead of enqueuing twice. */
  private pendingByRun = new Map<string, Promise<SlotHandle>>();
  /** FIFO. */
  private waiters: Waiter[] = [];

  constructor(opts: { capacity: number }) {
    if (!Number.isFinite(opts.capacity) || opts.capacity < 0) {
      throw new Error(`invalid slot-pool capacity: ${opts.capacity}`);
    }
    this.capacity = Math.floor(opts.capacity);
  }

  getCapacity(): number {
    return this.capacity;
  }

  /** Number of runs currently holding a slot. */
  size(): number {
    return this.holders.size;
  }

  /** Number of runs currently waiting on the FIFO queue. */
  waiterCount(): number {
    return this.waiters.length;
  }

  /** True when the run already holds a slot. Used by DirLockManager to skip
   *  acquire entirely on re-entry from sibling branches or sequential nodes. */
  hasSlot(runId: string): boolean {
    return this.holders.has(runId);
  }

  /**
   * Acquire a slot for `runId`. If the run already holds one, returns its
   * existing handle. If a sibling acquire is already pending for this run,
   * returns the in-flight promise. Otherwise enqueues FIFO.
   *
   * The returned handle's `release` is idempotent and is also called
   * automatically on `releaseRun(runId)` from the run's settle path.
   */
  acquireForRun(opts: {
    runId: string;
    nodeId: string;
    signal?: AbortSignal;
  }): Promise<SlotHandle> {
    const { runId, nodeId, signal } = opts;

    // Already holds → return existing handle directly. Sibling parallel
    // branches and sequential nodes hit this path.
    const held = this.holders.get(runId);
    if (held) return Promise.resolve(held);

    // Acquire in flight → join.
    const pending = this.pendingByRun.get(runId);
    if (pending) return pending;

    if (signal?.aborted) {
      return Promise.reject(new Error('slot acquire aborted'));
    }

    // Fast path: capacity available.
    if (this.holders.size < this.capacity) {
      const handle = this.mintHandle(runId);
      return Promise.resolve(handle);
    }

    // Slow path: enqueue.
    const promise = new Promise<SlotHandle>((resolve, reject) => {
      const waiter: Waiter = { runId, nodeId, resolve, reject, signal };
      if (signal) {
        const listener = () => this.removeWaiter(waiter, new Error('slot acquire aborted'));
        waiter.abortListener = listener;
        signal.addEventListener('abort', listener, { once: true });
      }
      this.waiters.push(waiter);
    });
    this.pendingByRun.set(runId, promise);
    // pendingByRun is cleared by mintHandle (on promotion) or removeWaiter
    // (on abort/cancel). No defensive .finally here — it would create an
    // extra unhandled rejection that mirrors the waiter's rejection.
    return promise;
  }

  /**
   * Release this run's slot, if any. Called from the run's settle path.
   * Promotes the next FIFO waiter if capacity allows.
   */
  releaseRun(runId: string): void {
    const handle = this.holders.get(runId);
    if (handle) {
      // mintHandle's idempotent closure does the rest.
      handle.release();
      return;
    }
    // If the run was a waiter (cancelled before promotion), drop it.
    const idx = this.waiters.findIndex((w) => w.runId === runId);
    if (idx !== -1) {
      const [w] = this.waiters.splice(idx, 1);
      if (w.signal && w.abortListener) {
        w.signal.removeEventListener('abort', w.abortListener);
      }
      w.reject(new Error('slot acquire cancelled by run settle'));
      this.pendingByRun.delete(runId);
    }
  }

  /**
   * Change the cap. Raising drains the wait queue up to the new cap;
   * lowering does not preempt current holders.
   */
  setCapacity(n: number): void {
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`invalid slot-pool capacity: ${n}`);
    }
    this.capacity = Math.floor(n);
    this.drainWaiters();
  }

  /** Clear all state. Tests only. */
  clear(): void {
    for (const w of this.waiters) {
      if (w.signal && w.abortListener) {
        w.signal.removeEventListener('abort', w.abortListener);
      }
      w.reject(new Error('slot pool cleared'));
    }
    this.waiters = [];
    this.pendingByRun.clear();
    // Holders' handles call back into us via release(); clear the map first
    // so the callbacks short-circuit.
    this.holders.clear();
  }

  /* ─── internals ─────────────────────────────────────────────────────────── */

  private mintHandle(runId: string): SlotHandle {
    let released = false;
    const handle: SlotHandle = {
      acquiredAt: Date.now(),
      release: () => {
        if (released) return;
        released = true;
        if (this.holders.get(runId) === handle) {
          this.holders.delete(runId);
        }
        this.drainWaiters();
      },
    };
    this.holders.set(runId, handle);
    // Clear any pending-by-run entry so a follow-up acquire after settle
    // doesn't observe a stale promise.
    this.pendingByRun.delete(runId);
    return handle;
  }

  private drainWaiters(): void {
    while (this.holders.size < this.capacity && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.signal && next.abortListener) {
        next.signal.removeEventListener('abort', next.abortListener);
      }
      // Skip waiters whose runId already became a holder (defensive — a
      // sibling shouldn't enqueue, but if state ever diverges, don't
      // double-mint).
      if (this.holders.has(next.runId)) {
        this.pendingByRun.delete(next.runId);
        next.resolve(this.holders.get(next.runId)!);
        continue;
      }
      const handle = this.mintHandle(next.runId);
      next.resolve(handle);
    }
  }

  private removeWaiter(target: Waiter, err: Error): void {
    const idx = this.waiters.indexOf(target);
    if (idx === -1) return;
    this.waiters.splice(idx, 1);
    if (target.signal && target.abortListener) {
      target.signal.removeEventListener('abort', target.abortListener);
    }
    if (this.pendingByRun.get(target.runId)) {
      // If another sibling joined this pending, they share the rejection.
      this.pendingByRun.delete(target.runId);
    }
    target.reject(err);
  }
}
