/*
 * WorkflowEngine — registry of RunControllers.
 *
 * Multiple RunControllers may be alive at once; each `start()` allocates a
 * new controller, registers it under its runId, and kicks off its walk.
 * Settled controllers leave the `runs` map immediately; the most-recently-
 * started controller is retained as `last` so the no-arg `getState()` keeps
 * surfacing a meaningful snapshot for single-run consumers.
 *
 * Folder-touching back-pressure happens lazily inside the SlotPool — see
 * lib/server/slot-pool.ts and lib/server/dir-lock-manager.ts. The engine
 * itself does not gate admission.
 *
 * Public surface:
 *   - `start(wf, opts)`     resolves when the run settles
 *   - `startRun(wf, opts)`  returns { runId, completion } synchronously
 *   - `stop(runId?)`        cancels one run, or all live runs when no id
 *   - `getRun(runId)`       look up a live or remembered controller
 *   - `list()`              currently-alive controllers
 *   - `getState()`          most-recent controller's snapshot
 *   - `reset()`             clears registry, slot pool, lock manager (tests)
 */

import type { NodeExecutor, RunSnapshot, Workflow } from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';
import { nodeExecutors } from './nodes/index';
import { getWorkflow } from './workflow-store';
import { RunController, type WorkflowLoader } from './run-controller';
import { SlotPool } from './slot-pool';
import { DirLockManager } from './dir-lock-manager';

const DEFAULT_MAX_CONCURRENT_RUNS = 4;

function readMaxConcurrentFromEnv(): number {
  const raw = process.env.INFLOOP_MAX_CONCURRENT_RUNS;
  if (!raw) return DEFAULT_MAX_CONCURRENT_RUNS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_RUNS;
  return n;
}

export class WorkflowEngine {
  /** Currently-alive (running) controllers, keyed by runId. */
  private runs = new Map<string, RunController>();
  /** Retained after settle so the no-arg getState() returns the most-recent
   *  run's snapshot, matching pre-refactor behavior. Overwritten on next
   *  start(); not bounded — only one is ever held. */
  private last?: RunController;

  /** Shared across all controllers spawned by this engine. The slot pool
   *  gates folder-touching runs (lazy admission via DirLockManager); the
   *  lock manager wraps every CLI agent's cwd. Tests can override via
   *  the constructor's `opts`. */
  readonly slotPool: SlotPool;
  readonly lockManager: DirLockManager;

  private executors: Record<string, NodeExecutor>;
  private loadWorkflow: WorkflowLoader;

  constructor(
    executors: Record<string, NodeExecutor> = nodeExecutors,
    loadWorkflow: WorkflowLoader = getWorkflow,
    opts?: { maxConcurrentRuns?: number },
  ) {
    this.executors = executors;
    this.loadWorkflow = loadWorkflow;
    this.slotPool = new SlotPool({
      capacity: opts?.maxConcurrentRuns ?? readMaxConcurrentFromEnv(),
    });
    this.lockManager = new DirLockManager({ slotPool: this.slotPool });
  }

  getState(): RunSnapshot {
    if (this.last) return this.last.getState();
    return { status: 'idle', iterationByLoopId: {}, scope: {}, events: [] };
  }

  /** Return a specific run's snapshot, or undefined if no run with that id
   *  is alive or remembered as `last`. */
  getRun(runId: string): RunController | undefined {
    return this.runs.get(runId) ?? (this.last?.runId === runId ? this.last : undefined);
  }

  /** Currently-alive controllers. Excludes settled `last`. */
  list(): RunController[] {
    return [...this.runs.values()];
  }

  async start(
    workflow: Workflow,
    opts?: { resolvedInputs?: ResolvedInputs },
  ): Promise<void> {
    await this.startRun(workflow, opts).completion;
  }

  /**
   * Synchronous kickoff. Allocates the controller, registers it, kicks off
   * `controller.start()`, and returns the runId immediately along with a
   * promise that resolves when the run settles. This is the multi-run
   * entrypoint: callers that need the runId before settle (the trigger
   * queue, /api/run) use this instead of the TOCTOU `engine.start()` +
   * `getState().runId` dance.
   */
  startRun(
    workflow: Workflow,
    opts?: { resolvedInputs?: ResolvedInputs },
  ): { runId: string; completion: Promise<void> } {
    const controller = new RunController({
      runId: crypto.randomUUID(),
      workflow,
      executors: this.executors,
      loadWorkflow: this.loadWorkflow,
      lockManager: this.lockManager,
      slotPool: this.slotPool,
    });
    this.runs.set(controller.runId, controller);
    this.last = controller;
    const completion = controller.start(opts).finally(() => {
      this.runs.delete(controller.runId);
      // `last` deliberately retained for getState() back-compat.
    });
    return { runId: controller.runId, completion };
  }

  /**
   * Stop one run by id, or — if no id is given — abort every currently-alive
   * run (the pre-refactor `stop()` semantic, generalized).
   */
  stop(runId?: string): void {
    if (runId) {
      this.runs.get(runId)?.stop();
      return;
    }
    for (const r of this.runs.values()) r.stop();
  }

  /** Tests only. Drops registry + slot pool + lock manager state. */
  reset(): void {
    this.runs.clear();
    this.last = undefined;
    this.slotPool.clear();
    this.lockManager.clear();
  }
}

// Pin the singleton across Next.js dev module reloads (see event-bus.ts).
//
// IMPORTANT: bump ENGINE_VERSION whenever behavior of WorkflowEngine changes
// in a way that requires recreating the live instance. Without this, HMR
// picks up the new file but the cached instance under
// `globalThis.__infiniteLoopWorkflowRegistry` was constructed with the old
// class definition and behaves the old way for the rest of the dev server's
// life.
const ENGINE_VERSION = 13;

declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopWorkflowRegistry:
    | { instance: WorkflowEngine; version: number }
    | undefined;
}

const cached = globalThis.__infiniteLoopWorkflowRegistry;
const engineInstance =
  cached && cached.version === ENGINE_VERSION
    ? cached.instance
    : new WorkflowEngine();

if (
  !globalThis.__infiniteLoopWorkflowRegistry ||
  globalThis.__infiniteLoopWorkflowRegistry.version !== ENGINE_VERSION
) {
  globalThis.__infiniteLoopWorkflowRegistry = {
    instance: engineInstance,
    version: ENGINE_VERSION,
  };
}

export const workflowEngine = engineInstance;
