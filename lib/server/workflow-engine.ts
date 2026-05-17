/*
 * WorkflowEngine — singleton that walks a workflow graph.
 *
 * Phase 1 model:
 *  - Single active run.
 *  - BFS-style sequential walk along control edges.
 *  - Loop is built-in: when the engine encounters a `loop` node it walks the
 *    container's children until a `break` edge fires; `continue` re-enters.
 *  - Cancellation: AbortController; engine kills the active executor and
 *    settles run as `cancelled`. Catch routing comes in Phase 2.
 *
 * Phase 2 / U1:
 *  - `parallel` is built-in: branches walk concurrently with isolated scopes.
 *  - `subworkflow` is built-in: child workflow walked in the same run context
 *    with an isolated child scope; events tagged via `<subwf-id>/<child-id>`
 *    nodeId namespacing so we do not need to add new event fields.
 *
 * Templating is delegated to lib/server/templating.ts; the engine resolves
 * each text-typed config field of every node before invoking the executor.
 */

import type {
  EdgeHandle,
  LoopConfig,
  NodeExecutor,
  NodeExecutorContext,
  ParallelConfig,
  RunSnapshot,
  RunStatus,
  Scope,
  SubworkflowConfig,
  TerminalRunStatus,
  Workflow,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
} from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';
import { eventBus } from './event-bus';
import { nodeExecutors } from './nodes/index';
import { saveRun } from './run-store';
import { resolve as resolveTemplate } from './templating';
import { getWorkflow } from './workflow-store';
import { RunWorktreesImpl } from './worktree-manager';
import {
  collectBranchOutputs,
  identifyBranchRoots,
  lookupDotted,
  snapshotScope,
  successHandleFor,
} from './workflow-engine-helpers';

const TEXT_CONFIG_FIELDS: Partial<Record<string, string[]>> = {
  agent: ['prompt', 'cwd', 'worktreeRef'],
  condition: ['against'],
  branch: ['lhs', 'rhs'],
  // Script: `code` stays literal so template braces inside string literals
  // / f-strings aren't mangled. `cwd` is a top-level templated string;
  // `inputs` is a Record<string,string> resolved per-value below in
  // `resolveConfigTemplates`.
  script: ['cwd'],
  // Phase 2+: shell.cmd, judge.rubric, etc.
};

interface ExecutionScope {
  parentNode?: WorkflowNode;
  /** Iteration index for the nearest enclosing Loop. */
  loopIteration?: number;
  /** Stack of subworkflow node ids encountered on the way to here. Used to
   * namespace event nodeIds so the UI can scope highlights per subworkflow.
   * Empty for top-level runs. */
  subworkflowStack?: string[];
}

/** Sliding-window cap so a chatty Claude run can't grow the live-rehydration
 * buffer unboundedly. Most events are tiny; 5k entries ≈ a few hundred kB.
 * Bumped from 2k → 5k to accommodate concurrent parallel branches. */
const EVENT_HISTORY_CAP = 5000;

/** Higher cap for the persistence buffer. The persisted log is the full run
 * history a user reviews after the fact; we want it as complete as possible
 * without letting an infinite loop with chatty stdout OOM the server. When
 * exceeded, oldest events are dropped first and `truncated` is set on the
 * record so the UI can warn that earlier events are missing. */
const PERSIST_EVENT_CAP = 50_000;

/** Optional injection point for tests to substitute the workflow loader used
 * by `walkSubworkflow`. The engine defaults to `workflow-store.getWorkflow`. */
export type WorkflowLoader = (id: string) => Promise<Workflow>;

export class WorkflowEngine {
  private snapshot: RunSnapshot = {
    status: 'idle',
    iterationByLoopId: {},
    scope: {},
  };
  private workflow?: Workflow;
  private abort?: AbortController;
  private edgesBySource = new Map<string, WorkflowEdge[]>();
  private recentEvents: WorkflowEvent[] = [];
  private runEventLog: WorkflowEvent[] = [];
  private runEventLogTruncated = false;
  private currentRunId?: string;

  private executors: Record<string, NodeExecutor>;
  private loadWorkflow: WorkflowLoader;
  private currentRunWorktrees?: RunWorktreesImpl;

  constructor(
    executors: Record<string, NodeExecutor> = nodeExecutors,
    loadWorkflow: WorkflowLoader = getWorkflow,
  ) {
    this.executors = executors;
    this.loadWorkflow = loadWorkflow;
  }

  getState(): RunSnapshot {
    return { ...this.snapshot, events: this.recentEvents };
  }

  async start(
    workflow: Workflow,
    opts?: { resolvedInputs?: ResolvedInputs },
  ): Promise<void> {
    if (this.snapshot.status === 'running') {
      throw new Error('a run is already active');
    }

    this.workflow = workflow;
    this.abort = new AbortController();
    this.indexEdges(workflow.edges);
    const startedAt = Date.now();
    // Fresh runId per start(). Note: if the engine instance is replaced mid-run
    // (Next.js HMR / process restart), the in-flight run is orphaned and never
    // produces a history record. The live UI loses its run anyway in that
    // case, so we accept the gap rather than write a "running" placeholder
    // (which would accumulate as zombies without a reaper).
    this.currentRunId = crypto.randomUUID();
    // Per-run worktree manager. Lazy: a workflow that never opts into
    // useWorktree never touches git. Cleaned up unconditionally in the
    // settle path below.
    this.currentRunWorktrees = new RunWorktreesImpl(this.currentRunId);
    // Workflow globals are seeded into scope upfront so any node can
    // reference `{{globals.NAME}}`. They're stored as a plain record so
    // the templating resolver walks into them like any other namespaced
    // scope entry.
    const seedScope: Scope = {};
    if (workflow.globals && typeof workflow.globals === 'object') {
      seedScope.globals = { ...workflow.globals };
    }
    if (opts?.resolvedInputs && typeof opts.resolvedInputs === 'object') {
      // Pre-resolved by the caller (API route or subworkflow executor); the
      // engine does no validation here — it just seeds.
      seedScope.inputs = { ...opts.resolvedInputs };
    }
    this.snapshot = {
      status: 'running',
      runId: this.currentRunId,
      workflowId: workflow.id,
      iterationByLoopId: {},
      scope: seedScope,
      startedAt,
    };

    // Reset both buffers at the start of a new run so a refresh doesn't
    // surface events from a previous run.
    this.recentEvents = [];
    this.runEventLog = [];
    this.runEventLogTruncated = false;
    const captureUnsub = eventBus.subscribe((ev) => {
      this.recentEvents.push(ev);
      if (this.recentEvents.length > EVENT_HISTORY_CAP) {
        this.recentEvents.shift();
      }
      this.runEventLog.push(ev);
      if (this.runEventLog.length > PERSIST_EVENT_CAP) {
        this.runEventLog.shift();
        this.runEventLogTruncated = true;
      }
    });

    eventBus.emit({
      type: 'run_started',
      workflowId: workflow.id,
      workflowName: workflow.name,
    });

    let finalStatus: TerminalRunStatus = 'failed';
    let errorMessage: string | undefined;

    try {
      const start = workflow.nodes.find((n) => n.type === 'start');
      if (!start) throw new Error("workflow has no 'start' node");

      const result = await this.walkFrom(start, {}, this.snapshot.scope, workflow);
      finalStatus = result;
    } catch (err) {
      if (this.abort.signal.aborted) {
        finalStatus = 'cancelled';
        errorMessage = 'cancelled by user';
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
        eventBus.emit({ type: 'error', message: errorMessage });
        finalStatus = 'failed';
      }
    }

    // Tear down any worktrees the run opened. `walkFrom` has returned, so
    // every agent CLI has already exited (the runner awaits child close
    // before resolving) and the directories are safe to remove. Errors are
    // surfaced as events but do not change the run's terminal status — a
    // half-cleaned `.infloop-worktrees/` is annoying, not a run failure.
    if (this.currentRunWorktrees) {
      try {
        await this.currentRunWorktrees.cleanupAll();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        eventBus.emit({
          type: 'error',
          message: `worktree cleanup failed: ${message}`,
        });
      }
      this.currentRunWorktrees = undefined;
    }

    const finishedAt = Date.now();
    this.snapshot = {
      ...this.snapshot,
      status: finalStatus,
      finishedAt,
      errorMessage,
    };
    eventBus.emit({
      type: 'run_finished',
      status: finalStatus,
      scope: this.snapshot.scope,
    });

    // Stop capturing now that the run is over; the buffer keeps the recorded
    // events around for refresh hydration until the next run starts.
    captureUnsub();

    // Snapshot every value the persist task needs RIGHT NOW. `persistRun` is
    // fire-and-forget: if a second run starts before this task gets its first
    // tick, the engine's mutable fields (currentRunId, runEventLog, scope)
    // will already belong to the new run. Capturing locals decouples the
    // persisted record from any later state change.
    const eventsForPersist = this.runEventLog.slice();
    const truncatedForPersist = this.runEventLogTruncated;
    const scopeForPersist = this.snapshot.scope;
    const runIdForPersist = this.currentRunId;

    // Persist the run record. Failures are non-fatal: we surface a single
    // `error` event so the UI can show "history not saved" without taking
    // down the engine on a transient disk hiccup.
    if (runIdForPersist) {
      void this.persistRun({
        runId: runIdForPersist,
        workflow,
        status: finalStatus,
        startedAt,
        finishedAt,
        errorMessage,
        events: eventsForPersist,
        truncated: truncatedForPersist,
        scope: scopeForPersist,
      });
    }
  }

  private async persistRun(args: {
    runId: string;
    workflow: Workflow;
    status: TerminalRunStatus;
    startedAt: number;
    finishedAt: number;
    errorMessage: string | undefined;
    events: WorkflowEvent[];
    truncated: boolean;
    scope: Scope;
  }): Promise<void> {
    try {
      await saveRun({
        runId: args.runId,
        workflowId: args.workflow.id,
        workflowName: args.workflow.name,
        status: args.status,
        startedAt: args.startedAt,
        finishedAt: args.finishedAt,
        durationMs: args.finishedAt - args.startedAt,
        scope: args.scope,
        errorMessage: args.errorMessage,
        events: args.events,
        truncated: args.truncated || undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[engine] saveRun failed:', message);
      eventBus.emit({
        type: 'error',
        message: `history not saved: ${message}`,
      });
    }
  }

  stop(): void {
    if (this.snapshot.status !== 'running') return;
    this.abort?.abort();
  }

  reset(): void {
    this.snapshot = { status: 'idle', iterationByLoopId: {}, scope: {} };
    this.workflow = undefined;
    this.abort = undefined;
    this.edgesBySource.clear();
    // Defense in depth: the settle path in start() already nulls this, but if
    // a future caller ever invokes reset() between an abort and the natural
    // settle, we don't want a stale manager to carry entries into the next
    // run.
    this.currentRunWorktrees = undefined;
  }

  /* ─── internals ─────────────────────────────────────────────────────────── */

  private indexEdges(edges: WorkflowEdge[]) {
    this.edgesBySource.clear();
    for (const e of edges) {
      const list = this.edgesBySource.get(e.source) ?? [];
      list.push(e);
      this.edgesBySource.set(e.source, list);
    }
  }

  private nodesById(
    workflow: Workflow,
  ): Map<string, { node: WorkflowNode; parent?: WorkflowNode }> {
    const map = new Map<string, { node: WorkflowNode; parent?: WorkflowNode }>();
    const visit = (n: WorkflowNode, parent?: WorkflowNode) => {
      map.set(n.id, { node: n, parent });
      for (const c of n.children ?? []) visit(c, n);
    };
    for (const n of workflow.nodes) visit(n);
    return map;
  }

  /**
   * Walk forward from `node` until reaching an `end` node, exhausting all
   * outgoing edges of the active branch, or hitting a settle condition.
   * Returns the run's terminal status.
   *
   * `scope` is the active variable scope to read from / write into. Top-level
   * walks pass `this.snapshot.scope`; parallel branches pass a branch-local
   * scope; subworkflows pass a fresh child scope.
   */
  private async walkFrom(
    node: WorkflowNode,
    exec: ExecutionScope,
    scope: Scope,
    workflow: Workflow,
    signal: AbortSignal = this.abort!.signal,
  ): Promise<Exclude<RunStatus, 'idle' | 'running'>> {
    let current: WorkflowNode | undefined = node;
    const allNodes = this.nodesById(workflow);

    while (current) {
      if (signal.aborted) return 'cancelled';

      this.snapshot.currentNodeId = this.namespaced(current.id, exec);

      if (current.type === 'loop') {
        const loopOutcome = await this.walkLoop(
          current,
          exec,
          scope,
          workflow,
          signal,
        );
        if (loopOutcome.terminal) return loopOutcome.status!;
        current = this.followBranch(current.id, 'next', allNodes, workflow);
        continue;
      }

      if (current.type === 'parallel' || current.type === 'subworkflow') {
        const branch =
          current.type === 'parallel'
            ? await this.walkParallel(current, exec, scope, workflow, signal)
            : await this.walkSubworkflow(current, exec, scope, signal);
        if (branch === 'cancelled') return 'cancelled';
        const next = this.followBranch(current.id, branch, allNodes, workflow);
        if (!next) return branch === 'error' ? 'failed' : 'succeeded';
        current = next;
        continue;
      }

      const branch = await this.executeNode(current, exec, scope, signal);

      if (current.type === 'end') {
        const cfg = current.config as { outcome?: 'succeeded' | 'failed' };
        return cfg.outcome ?? 'succeeded';
      }

      // Inside a loop body, met/break exits the loop, not_met/continue re-enters.
      if (exec.parentNode?.type === 'loop') {
        if (branch === 'met' || branch === 'break') {
          this.setLoopSignal('break');
          return 'succeeded';
        }
        if (branch === 'not_met' || branch === 'continue') {
          this.setLoopSignal('continue');
          return 'succeeded';
        }
        if (branch === 'error') {
          const errNext = this.followBranch(current.id, branch, allNodes, workflow);
          if (errNext) {
            current = errNext;
            continue;
          }
          return 'failed';
        }
        const next = this.followBranch(current.id, branch, allNodes, workflow);
        if (!next) {
          this.setLoopSignal('continue');
          return 'succeeded';
        }
        current = next;
        continue;
      }

      // Top-level walk.
      const next = this.followBranch(current.id, branch, allNodes, workflow);
      if (!next) {
        if (branch === 'error') return 'failed';
        return 'succeeded';
      }
      current = next;
    }

    return 'succeeded';
  }

  /**
   * Walk a Loop container's body. Each iteration starts at the first child.
   */
  private async walkLoop(
    loopNode: WorkflowNode,
    exec: ExecutionScope,
    scope: Scope,
    workflow: Workflow,
    signal: AbortSignal,
  ): Promise<{ terminal: boolean; status?: Exclude<RunStatus, 'idle' | 'running'> }> {
    const cfg = loopNode.config as LoopConfig;
    const max = cfg.maxIterations ?? 100;
    const infinite = cfg.infinite === true;
    const children = loopNode.children ?? [];
    if (children.length === 0) return { terminal: false };

    const bodyEntry = children[0];
    const bodyExec: ExecutionScope = {
      parentNode: loopNode,
      subworkflowStack: exec.subworkflowStack,
    };

    for (let i = 1; infinite || i <= max; i++) {
      if (signal.aborted) return { terminal: true, status: 'cancelled' };

      this.snapshot.iterationByLoopId[loopNode.id] = i;
      bodyExec.loopIteration = i;

      (this.snapshot as unknown as { _loopSignal?: EdgeHandle })._loopSignal = undefined;

      const bodyStatus = await this.walkFrom(bodyEntry, bodyExec, scope, workflow, signal);

      const loopSig = this.readLoopSignal();
      if (loopSig === 'break') return { terminal: false };
      if (loopSig === 'continue') continue;
      return { terminal: true, status: bodyStatus };
    }
    return { terminal: false };
  }

  /**
   * Walk a Parallel container. Branch identification: each direct child of
   * the parallel node whose id is NOT the target of any edge whose source is
   * also a child of the same parallel container is a "branch root." That
   * branch's sub-DAG is the branch root + everything reachable inside the
   * container along edges whose source AND target are children.
   *
   * Each branch:
   *   - receives a frozen snapshot copy of the parent scope
   *   - runs in its own `walkFrom` task with its own scope object
   *   - gets a per-branch AbortController chained off the run signal
   *
   * Mode → success branch handle:
   *   wait-all → 'all_done', race → 'first_done', quorum → 'quorum_met'
   */
  private async walkParallel(
    parallelNode: WorkflowNode,
    exec: ExecutionScope,
    parentScope: Scope,
    workflow: Workflow,
    signal: AbortSignal,
  ): Promise<EdgeHandle | 'cancelled'> {
    const cfg = parallelNode.config as ParallelConfig;
    const children = parallelNode.children ?? [];
    if (children.length === 0) {
      // Empty container → success-by-default.
      parentScope[parallelNode.id] = {
        mode: cfg.mode,
        completed: 0,
        failed: 0,
        children: {},
      };
      return successHandleFor(cfg.mode);
    }

    const childIds = new Set(children.map((c) => c.id));
    const branchRoots = identifyBranchRoots(children, workflow.edges, childIds);

    // Snapshot the parent scope at parallel-entry time. Each branch gets a
    // shallow per-key copy so it can write its own outputs without colliding
    // with siblings. Inputs read from the snapshot's frozen view.
    const parentSnapshot = snapshotScope(parentScope);

    type BranchResult = {
      branchId: string;
      status: 'succeeded' | 'failed' | 'cancelled';
      outputs: Record<string, unknown>;
      error?: string;
    };

    // Each branch has its own AbortController, chained off the parent signal.
    const branchControllers = new Map<string, AbortController>();
    const branchScopes = new Map<string, Scope>();
    for (const root of branchRoots) {
      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
      branchControllers.set(root.id, ctrl);
      branchScopes.set(root.id, { ...parentSnapshot });
    }

    const need = cfg.mode === 'quorum' ? Math.max(1, cfg.quorumN ?? 1) : 0;
    const onError = cfg.onError;
    const winners: string[] = []; // branch ids that succeeded, in completion order
    const completedFailures: string[] = []; // branch ids that failed (non-cancelled)

    const branchPromise = async (root: WorkflowNode): Promise<BranchResult> => {
      const branchScope = branchScopes.get(root.id)!;
      const branchCtrl = branchControllers.get(root.id)!;
      const branchExec: ExecutionScope = {
        parentNode: parallelNode,
        loopIteration: exec.loopIteration,
        subworkflowStack: exec.subworkflowStack,
      };
      try {
        const status = await this.walkFrom(
          root,
          branchExec,
          branchScope,
          workflow,
          branchCtrl.signal,
        );
        if (branchCtrl.signal.aborted) {
          return { branchId: root.id, status: 'cancelled', outputs: {} };
        }
        // Branch outputs: everything the branch wrote that wasn't already in
        // the parent snapshot. We expose the branch root's own outputs plus
        // anything written by descendants reachable inside the container.
        const outputs = collectBranchOutputs(branchScope, parentSnapshot);
        if (status === 'succeeded') {
          return { branchId: root.id, status: 'succeeded', outputs };
        }
        return {
          branchId: root.id,
          status: 'failed',
          outputs,
          error: typeof outputs.errorMessage === 'string' ? outputs.errorMessage : status,
        };
      } catch (err) {
        if (branchCtrl.signal.aborted) {
          return { branchId: root.id, status: 'cancelled', outputs: {} };
        }
        return {
          branchId: root.id,
          status: 'failed',
          outputs: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    // We resolve `done` once we know the parallel's outcome. After that we
    // abort any still-running siblings; their final result still streams in
    // via Promise.all so we can record `cancelled` status accurately.
    let resolveOutcome!: (v: 'success' | 'error' | 'cancelled') => void;
    const outcomePromise = new Promise<'success' | 'error' | 'cancelled'>((r) => {
      resolveOutcome = r;
    });
    let outcomeSettled = false;
    const settleOutcome = (v: 'success' | 'error' | 'cancelled') => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      resolveOutcome(v);
    };

    const cancelAllSiblings = () => {
      for (const c of branchControllers.values()) c.abort();
    };

    // Track each branch's completion individually so we can settle early.
    const all = branchRoots.map((root) =>
      branchPromise(root).then((res) => {
        if (res.status === 'succeeded') {
          winners.push(res.branchId);
          if (cfg.mode === 'race') {
            settleOutcome('success');
            cancelAllSiblings();
          } else if (cfg.mode === 'quorum' && winners.length >= need) {
            settleOutcome('success');
            cancelAllSiblings();
          }
        } else if (res.status === 'failed') {
          completedFailures.push(res.branchId);
          if (onError === 'fail-fast') {
            settleOutcome('error');
            cancelAllSiblings();
          }
        }
        return res;
      }),
    );

    // When all branches resolve, settle if we haven't already.
    void Promise.all(all).then(() => {
      if (signal.aborted) {
        settleOutcome('cancelled');
        return;
      }
      // best-effort or wait-all: decide based on surviving counts.
      if (cfg.mode === 'wait-all') {
        if (completedFailures.length === 0) settleOutcome('success');
        else settleOutcome('error');
        return;
      }
      if (cfg.mode === 'race') {
        if (winners.length > 0) settleOutcome('success');
        else settleOutcome('error');
        return;
      }
      // quorum
      if (winners.length >= need) settleOutcome('success');
      else settleOutcome('error');
    });

    const outcome = await outcomePromise;
    // Always wait for branches to actually settle (so we can record
    // cancelled-status entries) before writing scope.
    const results = await Promise.all(all);

    // Build outputs.
    const childrenOut: Record<
      string,
      { status: 'succeeded' | 'failed' | 'cancelled'; outputs: Record<string, unknown>; error?: string }
    > = {};
    let completed = 0;
    let failed = 0;
    // race: only the winner; quorum: only winners; wait-all/best-effort: all.
    const includeAll = cfg.mode === 'wait-all' || onError === 'best-effort';
    for (const r of results) {
      if (
        includeAll ||
        (cfg.mode === 'race' && r.branchId === winners[0]) ||
        (cfg.mode === 'quorum' && winners.includes(r.branchId))
      ) {
        childrenOut[r.branchId] = {
          status: r.status,
          outputs: r.outputs,
          ...(r.error !== undefined ? { error: r.error } : {}),
        };
      }
      if (r.status === 'succeeded') completed++;
      else if (r.status === 'failed') failed++;
    }

    const out: Record<string, unknown> = {
      mode: cfg.mode,
      completed,
      failed,
      children: childrenOut,
    };
    if (cfg.mode === 'race' && winners.length > 0) out.winner = winners[0];
    if (cfg.mode === 'quorum') out.winners = winners.slice(0, need);

    parentScope[parallelNode.id] = out;

    if (signal.aborted) return 'cancelled';
    if (outcome === 'cancelled') return 'cancelled';
    if (outcome === 'success') return successHandleFor(cfg.mode);

    // error path
    const offending = completedFailures[0];
    eventBus.emit({
      type: 'error',
      nodeId: this.namespaced(parallelNode.id, exec),
      message: offending
        ? `parallel branch "${offending}" failed`
        : 'parallel: success criterion not met',
    });
    return 'error';
  }

  /**
   * Walk a Subworkflow node:
   *  1. Resolve `inputs` against parent scope.
   *  2. Load child workflow via the configured loader.
   *  3. Run child with a fresh `{ __inputs: ... }` scope, reusing this run's
   *     signal and event bus.
   *  4. On success: copy declared `outputs` into the parent scope under the
   *     subworkflow node's id; route 'next'.
   *  5. On failure: write status/errorMessage; route 'error'.
   *
   * We DO NOT call `engine.start(...)` (which rejects when a run is active);
   * the child workflow walks inside the parent run context. We tag emitted
   * events by namespacing nodeIds as `<subwf-id>/<child-id>` so the UI can
   * scope highlights without us adding new fields to WorkflowEvent.
   */
  private async walkSubworkflow(
    node: WorkflowNode,
    exec: ExecutionScope,
    parentScope: Scope,
    signal: AbortSignal,
  ): Promise<EdgeHandle | 'cancelled'> {
    const cfg = node.config as SubworkflowConfig;

    // 1. Resolve inputs.
    const resolvedInputs: Record<string, unknown> = {};
    for (const [name, template] of Object.entries(cfg.inputs ?? {})) {
      if (typeof template === 'string') {
        const { text } = resolveTemplate(template, parentScope);
        resolvedInputs[name] = text;
      } else {
        resolvedInputs[name] = template;
      }
    }

    eventBus.emit({
      type: 'node_started',
      nodeId: this.namespaced(node.id, exec),
      nodeType: 'subworkflow',
      resolvedConfig: { workflowId: cfg.workflowId, inputs: resolvedInputs },
      loopIteration: exec.loopIteration,
    });

    const startedAt = Date.now();

    // 2. Load child workflow.
    let child: Workflow;
    try {
      child = await this.loadWorkflow(cfg.workflowId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const out = { status: 'failed', errorMessage: `subworkflow load failed: ${message}` };
      parentScope[node.id] = out;
      eventBus.emit({
        type: 'error',
        nodeId: this.namespaced(node.id, exec),
        message: out.errorMessage,
      });
      eventBus.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

    // 3. Build child scope and walk.
    // Child scope exposes the resolved inputs under both `inputs.NAME`
    // (the new top-level convention) AND `__inputs.NAME` (preserved for
    // back-compat with existing subworkflow JSONs that still reference
    // `{{__inputs.NAME}}`). Values are pass-through from the parent's
    // templated `cfg.inputs`; strict typed validation against
    // `child.inputs` declarations is intentionally not applied here —
    // see the design doc for the rationale.
    const childScope: Scope = {
      inputs: { ...resolvedInputs },
      __inputs: { ...resolvedInputs },
    };
    const childExec: ExecutionScope = {
      subworkflowStack: [...(exec.subworkflowStack ?? []), node.id],
    };
    const childStart = child.nodes.find((n) => n.type === 'start');
    if (!childStart) {
      const out = {
        status: 'failed',
        errorMessage: `subworkflow "${cfg.workflowId}" has no start node`,
      };
      parentScope[node.id] = out;
      eventBus.emit({
        type: 'error',
        nodeId: this.namespaced(node.id, exec),
        message: out.errorMessage,
      });
      eventBus.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

    let childStatus: Exclude<RunStatus, 'idle' | 'running'>;
    try {
      childStatus = await this.walkFrom(childStart, childExec, childScope, child, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const out = { status: 'failed', errorMessage: message };
      parentScope[node.id] = out;
      eventBus.emit({
        type: 'error',
        nodeId: this.namespaced(node.id, exec),
        message,
      });
      eventBus.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

    // 4 / 5. Settle.
    if (childStatus === 'cancelled') return 'cancelled';

    if (childStatus !== 'succeeded') {
      const out: Record<string, unknown> = { status: 'failed' };
      out.errorMessage = `subworkflow "${cfg.workflowId}" finished as ${childStatus}`;
      parentScope[node.id] = out;
      eventBus.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

    // Output copy. Each value of cfg.outputs is a dotted path into childScope.
    const out: Record<string, unknown> = { status: 'succeeded' };
    for (const [parentName, childPath] of Object.entries(cfg.outputs ?? {})) {
      const value = lookupDotted(childScope, childPath);
      out[parentName] = value;
    }
    parentScope[node.id] = out;

    eventBus.emit({
      type: 'node_finished',
      nodeId: this.namespaced(node.id, exec),
      nodeType: 'subworkflow',
      branch: 'next',
      outputs: out,
      durationMs: Date.now() - startedAt,
    });

    return 'next';
  }

  private namespaced(id: string, exec: ExecutionScope): string {
    if (!exec.subworkflowStack || exec.subworkflowStack.length === 0) return id;
    return `${exec.subworkflowStack.join('/')}/${id}`;
  }

  private setLoopSignal(signal: 'break' | 'continue'): void {
    (this.snapshot as unknown as { _loopSignal?: EdgeHandle })._loopSignal = signal;
  }

  private readLoopSignal(): EdgeHandle | undefined {
    return (this.snapshot as unknown as { _loopSignal?: EdgeHandle })._loopSignal;
  }

  private followBranch(
    sourceId: string,
    branch: EdgeHandle,
    allNodes: Map<string, { node: WorkflowNode; parent?: WorkflowNode }>,
    workflow: Workflow,
  ): WorkflowNode | undefined {
    // Edges live on the workflow that contains the node. For top-level we use
    // the cached engine index; for child workflows (subworkflow) we need
    // per-workflow edge indexing. Rebuild on demand for non-top-level walks.
    const edges =
      workflow === this.workflow
        ? this.edgesBySource.get(sourceId) ?? []
        : workflow.edges.filter((e) => e.source === sourceId);
    const edge = edges.find((e) => e.sourceHandle === branch);
    if (!edge) return undefined;
    return allNodes.get(edge.target)?.node;
  }

  private async executeNode(
    node: WorkflowNode,
    exec: ExecutionScope,
    scope: Scope,
    signal: AbortSignal,
  ): Promise<EdgeHandle> {
    const executor = this.executors[node.type];
    if (!executor) throw new Error(`unknown node type: ${node.type}`);

    const resolvedConfig = this.resolveConfigTemplates(node, scope, exec);
    const namespacedId = this.namespaced(node.id, exec);

    eventBus.emit({
      type: 'node_started',
      nodeId: namespacedId,
      nodeType: node.type,
      resolvedConfig,
      loopIteration: exec.loopIteration,
    });

    const cwd =
      typeof (resolvedConfig as { cwd?: unknown }).cwd === 'string'
        ? ((resolvedConfig as { cwd: string }).cwd as string)
        : process.cwd();

    const startedAt = Date.now();
    const ctx: NodeExecutorContext = {
      nodeId: node.id,
      config: resolvedConfig,
      scope,
      defaultCwd: cwd,
      signal,
      loopIteration: exec.loopIteration,
      emitStdoutChunk: (line: string) => {
        eventBus.emit({
          type: 'stdout_chunk',
          nodeId: namespacedId,
          line,
          loopIteration: exec.loopIteration,
        });
      },
      runWorktrees: this.currentRunWorktrees,
    };

    let result;
    try {
      result = await executor.execute(ctx);
    } catch (err) {
      if (signal.aborted) {
        // Re-throw abort so callers can settle as cancelled.
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      eventBus.emit({ type: 'error', nodeId: namespacedId, message });
      result = { outputs: { errorMessage: message }, branch: 'error' as EdgeHandle };
    }

    scope[node.id] = result.outputs;
    eventBus.emit({
      type: 'node_finished',
      nodeId: namespacedId,
      nodeType: node.type,
      branch: result.branch,
      outputs: result.outputs,
      durationMs: Date.now() - startedAt,
    });

    if (node.type === 'condition') {
      const out = result.outputs as { met?: boolean; detail?: string };
      eventBus.emit({
        type: 'condition_checked',
        nodeId: namespacedId,
        met: Boolean(out.met),
        detail: typeof out.detail === 'string' ? out.detail : '',
      });
    }

    return result.branch;
  }

  private resolveConfigTemplates(
    node: WorkflowNode,
    scope: Scope,
    exec: ExecutionScope,
  ): Record<string, unknown> {
    const fields = TEXT_CONFIG_FIELDS[node.type] ?? [];
    const cfg = node.config as Record<string, unknown>;
    const resolved: Record<string, unknown> = { ...cfg };
    for (const field of fields) {
      const raw = cfg[field];
      if (typeof raw === 'string') {
        const { text, warnings } = resolveTemplate(raw, scope);
        resolved[field] = text;
        for (const w of warnings) {
          eventBus.emit({
            type: 'template_warning',
            nodeId: this.namespaced(node.id, exec),
            field,
            missingKey: w.missingKey,
          });
        }
      }
    }
    // Script's `inputs` is a name → templated-value Record; resolve each
    // value against scope. Mirrors how subworkflow handles its `inputs`.
    if (node.type === 'script') {
      const rawInputs = cfg.inputs;
      if (rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)) {
        const next: Record<string, string> = {};
        for (const [name, value] of Object.entries(rawInputs as Record<string, unknown>)) {
          if (typeof value !== 'string') continue;
          const { text, warnings } = resolveTemplate(value, scope);
          next[name] = text;
          for (const w of warnings) {
            eventBus.emit({
              type: 'template_warning',
              nodeId: this.namespaced(node.id, exec),
              field: `inputs.${name}`,
              missingKey: w.missingKey,
            });
          }
        }
        resolved.inputs = next;
      }
    }
    return resolved;
  }
}

// Pin the singleton across Next.js dev module reloads (see event-bus.ts).
//
// IMPORTANT: bump ENGINE_VERSION whenever behavior of WorkflowEngine changes
// in a way that requires recreating the live instance. Without this, Next.js
// HMR will pick up the new file but the cached instance under
// `globalThis.__infiniteLoopWorkflowEngine` was constructed with the old class
// definition and behaves the old way for the rest of the dev server's life.
const ENGINE_VERSION = 10; // v10: per-run worktree manager

declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopWorkflowEngine:
    | { instance: WorkflowEngine; version: number }
    | undefined;
}

const cached = globalThis.__infiniteLoopWorkflowEngine;
const engineInstance =
  cached && cached.version === ENGINE_VERSION
    ? cached.instance
    : new WorkflowEngine();

if (
  !globalThis.__infiniteLoopWorkflowEngine ||
  globalThis.__infiniteLoopWorkflowEngine.version !== ENGINE_VERSION
) {
  globalThis.__infiniteLoopWorkflowEngine = {
    instance: engineInstance,
    version: ENGINE_VERSION,
  };
}

export const workflowEngine: WorkflowEngine = engineInstance;
