/*
 * RunController — owns the state and execution of a single workflow run.
 *
 * Held by the WorkflowEngine registry under its runId. The registry can
 * own many concurrently; admission to the folder-touching slot pool is
 * lazy (first non-exempt directory lock acquire). See
 * `docs/concurrent-runs.md` for the design.
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
import { saveRun } from './run-store';
import { resolve as resolveTemplate } from './templating';
import { RunWorktreesImpl } from './worktree-manager';
import { releaseRun } from './mcp/output-registry';
import type { DirLockManager, LockWaitObserver } from './dir-lock-manager';
import type { SlotPool } from './slot-pool';
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

const EVENT_HISTORY_CAP = 5000;
const PERSIST_EVENT_CAP = 50_000;

export type WorkflowLoader = (id: string) => Promise<Workflow>;

export interface RunControllerDeps {
  runId: string;
  workflow: Workflow;
  executors: Record<string, NodeExecutor>;
  loadWorkflow: WorkflowLoader;
  /** Shared lock manager. Optional so unit tests can construct controllers
   *  without one — the lock surface on ctx is then absent and CLI agents
   *  spawn without lock coordination (matching pre-refactor behavior). */
  lockManager?: DirLockManager;
  /** Shared slot pool. Optional alongside lockManager for the same reason;
   *  released in the settle path so a never-acquired run cleans up cleanly. */
  slotPool?: SlotPool;
}

export class RunController {
  readonly runId: string;
  readonly workflow: Workflow;
  readonly abort: AbortController;
  snapshot: RunSnapshot;
  private edgesBySource = new Map<string, WorkflowEdge[]>();
  private recentEvents: WorkflowEvent[] = [];
  private runEventLog: WorkflowEvent[] = [];
  private runEventLogTruncated = false;
  private worktrees: RunWorktreesImpl;

  private executors: Record<string, NodeExecutor>;
  private loadWorkflow: WorkflowLoader;
  private lockManager?: DirLockManager;
  private slotPool?: SlotPool;

  constructor(deps: RunControllerDeps) {
    this.runId = deps.runId;
    this.workflow = deps.workflow;
    this.executors = deps.executors;
    this.loadWorkflow = deps.loadWorkflow;
    this.lockManager = deps.lockManager;
    this.slotPool = deps.slotPool;
    this.abort = new AbortController();
    this.worktrees = new RunWorktreesImpl(this.runId);
    this.snapshot = {
      status: 'idle',
      iterationByLoopId: {},
      scope: {},
    };
    this.indexEdges(this.workflow.edges);
  }

  getState(): RunSnapshot {
    return { ...this.snapshot, events: this.recentEvents };
  }

  stop(): void {
    if (this.snapshot.status !== 'running') return;
    this.abort.abort();
  }

  /**
   * Emit a run-scoped event. Stamps `runId` so downstream consumers (SSE
   * filters, the UI) can route by run without each emit site remembering.
   * Queue-scoped events (trigger_enqueued, trigger_dropped, etc.) bypass
   * this and go to `eventBus.emit` directly from their own modules.
   */
  emit(event: WorkflowEvent): void {
    const stamped = { ...(event as unknown as Record<string, unknown>), runId: this.runId } as WorkflowEvent;
    eventBus.emit(stamped);
  }

  /**
   * Build the wait-observer hooks the lock manager uses to set/clear
   * `snapshot.waitingFor`. Observable surface for "running but parked".
   * Returns a fresh object per call but the methods close over `this`.
   */
  private makeWaitObserver(): LockWaitObserver {
    return {
      onLockWaitStart: (nodeId, path, heldByRunId, heldByPath) => {
        this.snapshot = {
          ...this.snapshot,
          waitingFor: { kind: 'lock', nodeId, path, heldByRunId, heldByPath },
        };
      },
      onLockWaitEnd: (nodeId) => {
        // Only clear if the active wait still names this node; a later
        // wait may have already overwritten the field. KNOWN LIMITATION:
        // when two parallel branches of one run both park on locks, the
        // second wait overwrites the first in `snapshot.waitingFor`; when
        // the second resolves first, this clears the field even though
        // the first sibling is still parked. Events stay correct in the
        // SSE stream — only the polling snapshot is misleading until the
        // first sibling resolves. Acceptable for v1.
        if (this.snapshot.waitingFor?.nodeId === nodeId) {
          this.snapshot = { ...this.snapshot, waitingFor: undefined };
        }
      },
      onSlotWaitStart: (nodeId) => {
        this.snapshot = {
          ...this.snapshot,
          waitingFor: { kind: 'slot', nodeId },
        };
      },
      onSlotWaitEnd: (nodeId) => {
        if (this.snapshot.waitingFor?.nodeId === nodeId) {
          this.snapshot = { ...this.snapshot, waitingFor: undefined };
        }
      },
    };
  }

  /**
   * Run the workflow. Resolves when the run settles (succeeded / failed /
   * cancelled). Synchronously transitions the snapshot to `running` and
   * assigns `snapshot.runId` before its first await — the trigger-queue
   * adapter relies on this contract to read the runId off the engine right
   * after kicking off `start()`.
   */
  async start(opts?: { resolvedInputs?: ResolvedInputs }): Promise<void> {
    const workflow = this.workflow;
    const startedAt = Date.now();
    const seedScope: Scope = {};
    if (workflow.globals && typeof workflow.globals === 'object') {
      seedScope.globals = { ...workflow.globals };
    }
    if (opts?.resolvedInputs && typeof opts.resolvedInputs === 'object') {
      seedScope.inputs = { ...opts.resolvedInputs };
    }
    this.snapshot = {
      status: 'running',
      runId: this.runId,
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

    // Register the lock-wait observer so the lock manager can stamp
    // `snapshot.waitingFor` while a node is parked. The lock manager
    // unregisters via `releaseRun(runId)` in the settle path below.
    if (this.lockManager) {
      this.lockManager.registerObserver(this.runId, this.makeWaitObserver());
    }

    this.emit({
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
        this.emit({ type: 'error', message: errorMessage });
        finalStatus = 'failed';
      }
    }

    let finishedAt = Date.now();
    // Settle path. Wrapped in try/finally so the eventBus subscription is
    // always torn down even if a cleanup throws something the inner
    // try/catch didn't anticipate — leaking a captureUnsub leaks memory
    // for the rest of the process.
    try {
      // Tear down any worktrees the run opened. `walkFrom` has returned, so
      // every agent CLI has already exited and the directories are safe to
      // remove. Errors are surfaced as events but do not change the run's
      // terminal status — a half-cleaned `.infloop-worktrees/` is annoying,
      // not a run failure.
      try {
        await this.worktrees.cleanupAll();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({
          type: 'error',
          message: `worktree cleanup failed: ${message}`,
        });
      }

      // Sweep any SetOutput MCP tokens still bound to this run. The agent
      // executor always calls `consumeOutputs` in its `finally`, so under
      // normal flow this is a no-op. The sweep is defense-in-depth for the
      // case where the engine crashes between mint and consume.
      releaseRun(this.runId);

      // Release directory-lock state (worktree exempts, observer) and slot.
      // Order: lock state depends on the worktrees that cleanupAll just
      // removed, and the slot release lets a waiting run admit ASAP.
      this.lockManager?.releaseRun(this.runId);
      this.slotPool?.releaseRun(this.runId);

      finishedAt = Date.now();
      this.snapshot = {
        ...this.snapshot,
        status: finalStatus,
        finishedAt,
        errorMessage,
        waitingFor: undefined,
      };
      this.emit({
        type: 'run_finished',
        status: finalStatus,
        scope: this.snapshot.scope,
      });
    } finally {
      captureUnsub();
    }

    // Snapshot every value the persist task needs RIGHT NOW. `persistRun` is
    // fire-and-forget: if a second run starts before this task gets its first
    // tick, the controller's mutable fields would already belong to the new
    // run (in the multi-run world). Capturing locals decouples the persisted
    // record from any later state change.
    const eventsForPersist = this.runEventLog.slice();
    const truncatedForPersist = this.runEventLogTruncated;
    const scopeForPersist = this.snapshot.scope;

    void this.persistRun({
      runId: this.runId,
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
      this.emit({
        type: 'error',
        message: `history not saved: ${message}`,
      });
    }
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
   */
  private async walkFrom(
    node: WorkflowNode,
    exec: ExecutionScope,
    scope: Scope,
    workflow: Workflow,
    signal: AbortSignal = this.abort.signal,
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

      const next = this.followBranch(current.id, branch, allNodes, workflow);
      if (!next) {
        if (branch === 'error') return 'failed';
        return 'succeeded';
      }
      current = next;
    }

    return 'succeeded';
  }

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

    const parentSnapshot = snapshotScope(parentScope);

    type BranchResult = {
      branchId: string;
      status: 'succeeded' | 'failed' | 'cancelled';
      outputs: Record<string, unknown>;
      error?: string;
    };

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
    const winners: string[] = [];
    const completedFailures: string[] = [];

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

    void Promise.all(all).then(() => {
      if (signal.aborted) {
        settleOutcome('cancelled');
        return;
      }
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
      if (winners.length >= need) settleOutcome('success');
      else settleOutcome('error');
    });

    const outcome = await outcomePromise;
    const results = await Promise.all(all);

    const childrenOut: Record<
      string,
      { status: 'succeeded' | 'failed' | 'cancelled'; outputs: Record<string, unknown>; error?: string }
    > = {};
    let completed = 0;
    let failed = 0;
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

    const offending = completedFailures[0];
    this.emit({
      type: 'error',
      nodeId: this.namespaced(parallelNode.id, exec),
      message: offending
        ? `parallel branch "${offending}" failed`
        : 'parallel: success criterion not met',
    });
    return 'error';
  }

  private async walkSubworkflow(
    node: WorkflowNode,
    exec: ExecutionScope,
    parentScope: Scope,
    signal: AbortSignal,
  ): Promise<EdgeHandle | 'cancelled'> {
    const cfg = node.config as SubworkflowConfig;

    const resolvedInputs: Record<string, unknown> = {};
    for (const [name, template] of Object.entries(cfg.inputs ?? {})) {
      if (typeof template === 'string') {
        const { text } = resolveTemplate(template, parentScope);
        resolvedInputs[name] = text;
      } else {
        resolvedInputs[name] = template;
      }
    }

    this.emit({
      type: 'node_started',
      nodeId: this.namespaced(node.id, exec),
      nodeType: 'subworkflow',
      resolvedConfig: { workflowId: cfg.workflowId, inputs: resolvedInputs },
      loopIteration: exec.loopIteration,
    });

    const startedAt = Date.now();

    let child: Workflow;
    try {
      child = await this.loadWorkflow(cfg.workflowId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const out = { status: 'failed', errorMessage: `subworkflow load failed: ${message}` };
      parentScope[node.id] = out;
      this.emit({
        type: 'error',
        nodeId: this.namespaced(node.id, exec),
        message: out.errorMessage,
      });
      this.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

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
      this.emit({
        type: 'error',
        nodeId: this.namespaced(node.id, exec),
        message: out.errorMessage,
      });
      this.emit({
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
      this.emit({
        type: 'error',
        nodeId: this.namespaced(node.id, exec),
        message,
      });
      this.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

    if (childStatus === 'cancelled') return 'cancelled';

    if (childStatus !== 'succeeded') {
      const out: Record<string, unknown> = { status: 'failed' };
      out.errorMessage = `subworkflow "${cfg.workflowId}" finished as ${childStatus}`;
      parentScope[node.id] = out;
      this.emit({
        type: 'node_finished',
        nodeId: this.namespaced(node.id, exec),
        nodeType: 'subworkflow',
        branch: 'error',
        outputs: out,
        durationMs: Date.now() - startedAt,
      });
      return 'error';
    }

    const out: Record<string, unknown> = { status: 'succeeded' };
    for (const [parentName, childPath] of Object.entries(cfg.outputs ?? {})) {
      const value = lookupDotted(childScope, childPath);
      out[parentName] = value;
    }
    parentScope[node.id] = out;

    this.emit({
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
    // Edges live on the workflow that contains the node. For the top-level
    // workflow we use the cached index; for child workflows (subworkflow) we
    // build a per-call filter — these are rare and the workflows are small.
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

    this.emit({
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
      runId: this.runId,
      nodeId: node.id,
      config: resolvedConfig,
      scope,
      defaultCwd: cwd,
      signal,
      loopIteration: exec.loopIteration,
      emitStdoutChunk: (line: string) => {
        this.emit({
          type: 'stdout_chunk',
          nodeId: namespacedId,
          line,
          loopIteration: exec.loopIteration,
        });
      },
      runWorktrees: this.worktrees,
      acquireDirLock: this.lockManager
        ? (opts) => this.lockManager!.acquire({
            path: opts.path,
            runId: this.runId,
            nodeId: node.id,
            signal: opts.signal ?? signal,
          })
        : undefined,
      registerExempt: this.lockManager
        ? (canonical) => this.lockManager!.registerExempt(canonical, this.runId)
        : undefined,
    };

    let result;
    try {
      result = await executor.execute(ctx);
    } catch (err) {
      if (signal.aborted) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', nodeId: namespacedId, message });
      result = { outputs: { errorMessage: message }, branch: 'error' as EdgeHandle };
    }

    scope[node.id] = result.outputs;
    this.emit({
      type: 'node_finished',
      nodeId: namespacedId,
      nodeType: node.type,
      branch: result.branch,
      outputs: result.outputs,
      durationMs: Date.now() - startedAt,
    });

    if (node.type === 'condition') {
      const out = result.outputs as { met?: boolean; detail?: string };
      this.emit({
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
          this.emit({
            type: 'template_warning',
            nodeId: this.namespaced(node.id, exec),
            field,
            missingKey: w.missingKey,
          });
        }
      }
    }
    if (node.type === 'script') {
      const rawInputs = cfg.inputs;
      if (rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)) {
        const next: Record<string, string> = {};
        for (const [name, value] of Object.entries(rawInputs as Record<string, unknown>)) {
          if (typeof value !== 'string') continue;
          const { text, warnings } = resolveTemplate(value, scope);
          next[name] = text;
          for (const w of warnings) {
            this.emit({
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
