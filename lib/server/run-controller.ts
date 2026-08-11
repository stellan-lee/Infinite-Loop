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
  HumanDecisionRecord,
  LoopConfig,
  ManualConfig,
  ManualDecisionDecl,
  ManualDecisionKey,
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
import { MANUAL_DECISION_KEYS } from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';
import { eventBus } from './event-bus';
import { eventMemoryBudget, type EventMemoryBudget } from './event-memory-budget';
import { globalCostBudget, type GlobalCostBudget } from './cost-budget';
import { removeRunMarker, saveRun, writeRunMarker } from './run-store';
import { recordAudit } from './audit-log';
import { metrics } from './metrics';
import { resolve as resolveTemplate } from './templating';
import { RunWorktreesImpl } from './worktree-manager';
import { releaseRun } from './mcp/output-registry';
import { createLogger } from './logger';
import { newCorrelationId } from './correlation';
import type { DirLockManager, LockWaitObserver } from './dir-lock-manager';
import type { SlotPool } from './slot-pool';
import {
  collectBranchOutputs,
  identifyBranchRoots,
  lookupDotted,
  snapshotScope,
  successHandleFor,
} from './workflow-engine-helpers';

const log = createLogger('run-controller');

const TEXT_CONFIG_FIELDS: Partial<Record<string, string[]>> = {
  agent: ['prompt', 'cwd', 'worktreeRef'],
  condition: ['against'],
  branch: ['lhs', 'rhs'],
  // Script: `code` stays literal so template braces inside string literals
  // / f-strings aren't mangled. `cwd` is a top-level templated string;
  // `inputs` is a Record<string,string> resolved per-value below in
  // `resolveConfigTemplates`.
  script: ['cwd'],
  // Manual: brief and reviewerHint are the user-visible strings; templating
  // them lets the gate quote outputs from upstream nodes
  // ("Review {{agent-1.stdout}}").
  manual: ['brief', 'reviewerHint'],
};

/**
 * Subset of `TEXT_CONFIG_FIELDS` whose template references are *required*.
 * An unresolved `{{...}}` in one of these fields means the node would run on
 * a silently degraded value, so the engine fails the node loudly onto its
 * `error` branch instead of substituting an empty string and continuing.
 * Non-critical fields keep the warn-and-continue behavior (`template_warning`).
 *
 * `agent.prompt` is the canonical case: a partial prompt like
 * "summarize {{missing.ref}}" is still non-empty, so `agent.ts`'s own
 * empty-prompt guard does not catch it — the agent would burn a real,
 * billed provider call doing the wrong thing. This map is the extension
 * point for any future field with the same "must be meaningful" contract.
 */
const CRITICAL_CONFIG_FIELDS: Partial<Record<string, string[]>> = {
  agent: ['prompt'],
};

/** Final working-directory fallback for every executor. Kept explicit rather
 * than using the server process directory so workflows are portable. */
export const DEFAULT_WORKFLOW_CWD = '/tmp';

/** Resolve execution cwd with node-specific settings taking precedence over
 * the workflow-wide default. JSON workflows are external input, so blank or
 * whitespace-only values deliberately count as unset. */
export function resolveExecutionCwd(
  workflowCwd: unknown,
  nodeCwd: unknown,
): string {
  for (const value of [nodeCwd, workflowCwd]) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return DEFAULT_WORKFLOW_CWD;
}

interface ExecutionScope {
  parentNode?: WorkflowNode;
  /** Iteration index for the nearest enclosing Loop. */
  loopIteration?: number;
  /** Stack of subworkflow node ids encountered on the way to here. Used to
   * namespace event nodeIds so the UI can scope highlights per subworkflow.
   * Empty for top-level runs. */
  subworkflowStack?: string[];
}

/** Per-gate state held while a Manual node is parked. The `resolve` fn
 *  finishes the executor's `awaitHumanDecision()` promise; the controller
 *  removes the entry before invoking it so a duplicate submit cannot fire
 *  the same gate twice. */
interface ManualPendingDecision {
  brief: string;
  reviewerHint?: string;
  decisions: ManualDecisionDecl[];
  allowed: ManualDecisionKey[];
  since: number;
  resolve: (record: HumanDecisionRecord) => void;
}

export type SubmitDecisionResult =
  | { ok: true; record: HumanDecisionRecord }
  | {
      ok: false;
      reason:
        | 'run-not-running'
        | 'no-pending-decision'
        | 'invalid-decision'
        | 'decision-not-allowed';
      /** Decisions the gate accepts. Present for the two `*-decision*`
       *  reasons so the API can echo the right hint back. */
      allowed?: ManualDecisionKey[];
    };

function isManualDecisionKey(value: unknown): value is ManualDecisionKey {
  return (
    typeof value === 'string' &&
    (MANUAL_DECISION_KEYS as readonly string[]).includes(value)
  );
}

/* ─── per-run event-buffer hard caps ─────────────────────────────────────────
 *
 * Upper bounds on the two event buffers a single run keeps in memory:
 * `recentEvents` (SSE replay) and `runEventLog` (the to-be-persisted log). A
 * lone run is bounded by exactly these. Under concurrency the process-wide
 * `EventMemoryBudget` (see event-memory-budget.ts) hands each run a smaller
 * dynamic cap so the AGGREGATE across all live runs cannot OOM the process;
 * `trimEventBuffers` applies whichever is tighter. Exported so the buffer
 * tests can assert against the real ceilings rather than magic numbers.
 */
export const EVENT_HISTORY_CAP = 5000;
export const PERSIST_EVENT_CAP = 50_000;

/* ─── run-level execution budget ─────────────────────────────────────────────
 *
 * A safety ceiling on a single run. The per-loop `maxIterations` cap does not
 * cover `infinite: true` loops or nested-loop multiplication, and nothing caps
 * total work across a whole workflow — so an unbounded loop around an Agent
 * node can spend the user's API budget until a human notices. This budget is
 * the automatic backstop the manual kill switch isn't.
 *
 * Three independent ceilings, each disabled by a value of `0`:
 *
 * `maxNodeExecutions` counts node steps across the entire run — every node
 * the walk visits, including `start`/`end` and the `loop`/`parallel`/
 * `subworkflow` container nodes themselves, summed over every loop iteration
 * and every parallel branch. It is therefore a conservative ceiling, not a
 * precise count of "real work"; size it with headroom.
 *
 * `maxDurationMs` is a wall-clock cap, evaluated at each node-step boundary —
 * a single long-running node (e.g. an Agent CLI) is not interrupted
 * mid-flight; the cap trips on the next step. It defaults to a generous 24h:
 * a backstop against a genuinely-stuck run, NOT a tight SLA. Long autonomous
 * runs are this tool's whole point, so the default is wide enough not to kill
 * legitimate work while still bounding a run whose exit condition never fires.
 *
 * `maxCostUsd` is a cumulative cost ceiling in US dollars, accumulated from
 * the cost each Agent node's provider reports (see `recordCost`). It is
 * checked after each node settles — cost is only known once the node has run,
 * so unlike the two ceilings above it trips *after* the offending node, not
 * before it. It defaults to `0` (opt-in): no single dollar figure is safe for
 * every user, and a surprise mid-run abort destroys uncommitted agent work,
 * so the precise cost cap is left for the operator to set to their real
 * budget. Only providers that report cost contribute (currently the `claude`
 * CLI); HTTP providers report none, so a cost cap does not bound a workflow
 * built entirely on them — `maxDurationMs` remains their backstop.
 */
export interface RunBudget {
  maxNodeExecutions: number;
  maxDurationMs: number;
  maxCostUsd: number;
}

const DEFAULT_MAX_NODE_EXECUTIONS = 10_000;
/** 24h — a stuck-run backstop, not a tight SLA. See the budget block above. */
const DEFAULT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** 0 — opt-in: there is no universally-safe default dollar cap. */
const DEFAULT_MAX_COST_USD = 0;

function readBudgetEnvWith(
  name: string,
  fallback: number,
  parse: (raw: string) => number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parse(raw);
  // A literal 0 is meaningful — it disables that ceiling. NaN / negative is a
  // typo, not an intent to disable, so fall back to the default.
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Integer-valued budget env (node steps, milliseconds). */
function readBudgetEnv(name: string, fallback: number): number {
  return readBudgetEnvWith(name, fallback, (raw) => Number.parseInt(raw, 10));
}

/** Float-valued budget env — `maxCostUsd` is a dollar amount, not an integer. */
function readBudgetFloatEnv(name: string, fallback: number): number {
  return readBudgetEnvWith(name, fallback, (raw) => Number.parseFloat(raw));
}

/** Resolve the run budget from the environment. Called per controller so an
 *  env change is picked up by the next run without a process restart. */
export function resolveRunBudget(): RunBudget {
  return {
    maxNodeExecutions: readBudgetEnv(
      'INFLOOP_MAX_RUN_NODE_EXECUTIONS',
      DEFAULT_MAX_NODE_EXECUTIONS,
    ),
    maxDurationMs: readBudgetEnv(
      'INFLOOP_MAX_RUN_DURATION_MS',
      DEFAULT_MAX_DURATION_MS,
    ),
    maxCostUsd: readBudgetFloatEnv(
      'INFLOOP_MAX_RUN_COST_USD',
      DEFAULT_MAX_COST_USD,
    ),
  };
}

export type WorkflowLoader = (id: string) => Promise<Workflow>;

export interface RunControllerDeps {
  runId: string;
  workflow: Workflow;
  executors: Record<string, NodeExecutor>;
  loadWorkflow: WorkflowLoader;
  /** Correlation id of the ingress event that started this run. Threaded onto
   *  every emitted event, the audit entries, the run marker, and the persisted
   *  record. Optional: a controller built without one (unit tests, internal
   *  callers) mints its own so the field is never `undefined`. */
  correlationId?: string;
  /** Shared lock manager. Optional so unit tests can construct controllers
   *  without one — the lock surface on ctx is then absent and CLI agents
   *  spawn without lock coordination (matching pre-refactor behavior). */
  lockManager?: DirLockManager;
  /** Shared slot pool. Optional alongside lockManager for the same reason;
   *  released in the settle path so a never-acquired run cleans up cleanly. */
  slotPool?: SlotPool;
  /** Run-level safety ceiling. Partial overrides merge over the env-derived
   *  defaults (`resolveRunBudget`); omitted in production, supplied by tests
   *  to exercise the guard without running thousands of nodes. */
  budget?: Partial<RunBudget>;
  /** Process-wide event-memory budget. Optional — defaults to the shared
   *  singleton; tests inject one with a small cap to exercise buffer
   *  backpressure without buffering hundreds of thousands of events. */
  eventBudget?: EventMemoryBudget;
  /** Process-wide cost budget. Optional — defaults to the shared singleton;
   *  tests inject one with a small ceiling to exercise the aggregate cost
   *  trip without pushing real dollars through the engine. */
  costBudget?: GlobalCostBudget;
}

export class RunController {
  readonly runId: string;
  /** Correlation id tying this run back to the ingress event that started it.
   *  Always set — `deps.correlationId` or a freshly minted one. */
  readonly correlationId: string;
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

  /** Resolved run-level budget (env defaults merged with any deps override). */
  private readonly budget: RunBudget;
  /** Process-wide event-memory budget; bounds the aggregate event buffer
   *  across all live runs. See `trimEventBuffers`. */
  private readonly eventBudget: EventMemoryBudget;
  /** Process-wide cost budget; bounds cumulative provider-reported cost across
   *  all runs. Fed per costed node from `recordCost`. */
  private readonly costBudget: GlobalCostBudget;
  /** True between `eventBudget.register()` and its paired `unregister()` —
   *  guards both sides so they stay balanced even under a pathological
   *  double `start()`. */
  private eventBudgetRegistered = false;
  /** Node steps taken so far this run — counted against `budget`. */
  private nodeExecutionCount = 0;
  /** Provider-reported cost (USD) accumulated so far this run — counted
   *  against `budget.maxCostUsd`. Only providers that report a cost (CLI
   *  agents) contribute; reset per run in `start()`. */
  private runCostUsd = 0;
  /** Wall-clock start, captured in `start()`; used for the duration ceiling. */
  private runStartedAt = 0;
  /** Set when a budget ceiling trips; reclassifies the run as failed. */
  private budgetExceededMessage?: string;

  /** In-flight Manual-gate waiters keyed by namespaced node id (the same id
   *  used in events / snapshot.currentNodeId). At most one wait is active
   *  per node id at a time — the engine walks the graph serially per branch
   *  — but the map shape makes the lookup uniform and lets a future
   *  multi-gate workflow (e.g. parallel branches each parking) coexist. */
  private pendingDecisions = new Map<string, ManualPendingDecision>();

  constructor(deps: RunControllerDeps) {
    this.runId = deps.runId;
    this.correlationId = deps.correlationId ?? newCorrelationId();
    this.workflow = deps.workflow;
    this.executors = deps.executors;
    this.loadWorkflow = deps.loadWorkflow;
    this.lockManager = deps.lockManager;
    this.slotPool = deps.slotPool;
    this.budget = { ...resolveRunBudget(), ...deps.budget };
    this.eventBudget = deps.eventBudget ?? eventMemoryBudget;
    this.costBudget = deps.costBudget ?? globalCostBudget;
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

  /**
   * Events currently held in the persisted-event buffer (`runEventLog`) —
   * the dominant in-memory cost of a live run (the SSE replay buffer holds a
   * subset of the very same event objects). `/api/metrics` sums this across
   * live runs to expose `infloop_event_buffer_events`.
   */
  bufferedEventCount(): number {
    return this.runEventLog.length;
  }

  stop(): void {
    if (this.snapshot.status !== 'running') return;
    this.abort.abort();
  }

  /**
   * Emit a run-scoped event. Stamps `runId` and `correlationId` so downstream
   * consumers (SSE filters, the UI, the persisted event log) can route by run
   * and join back to the ingress event without each emit site remembering.
   * Queue-scoped events (trigger_enqueued, trigger_dropped, etc.) bypass this
   * and go to `eventBus.emit` directly from their own modules.
   */
  emit(event: WorkflowEvent): void {
    const stamped = {
      ...(event as unknown as Record<string, unknown>),
      runId: this.runId,
      correlationId: this.correlationId,
    } as WorkflowEvent;
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
    this.runStartedAt = startedAt;
    const seedScope: Scope = {};
    if (workflow.globals && typeof workflow.globals === 'object') {
      seedScope.globals = { ...workflow.globals };
    }
    if (opts?.resolvedInputs && typeof opts.resolvedInputs === 'object') {
      // Caller-supplied inputs are reachable as both `inputs` and `__inputs`,
      // mirroring the subworkflow child scope (see runSubworkflow). The docs
      // (docs/workflow-format.md) and the shipped library presets reference
      // `{{__inputs.NAME}}`; a top-level run that seeded only `inputs` left
      // those templates unresolved (caught by the production burn-in).
      seedScope.inputs = { ...opts.resolvedInputs };
      seedScope.__inputs = { ...opts.resolvedInputs };
    }
    this.snapshot = {
      status: 'running',
      runId: this.runId,
      workflowId: workflow.id,
      iterationByLoopId: {},
      scope: seedScope,
      startedAt,
    };

    // Persist a crash-recovery marker: if the server dies before this run
    // settles, the next boot turns this marker into a `failed` history record
    // (see crash-recovery.ts). Removed in `persistRun` once the run is safely
    // saved. Synchronous + best-effort — it never fails the run.
    writeRunMarker({
      runId: this.runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      startedAt,
      serverPid: process.pid,
      correlationId: this.correlationId,
    });

    // Reset both buffers at the start of a new run so a refresh doesn't
    // surface events from a previous run.
    this.recentEvents = [];
    this.runEventLog = [];
    this.runEventLogTruncated = false;
    this.nodeExecutionCount = 0;
    this.runCostUsd = 0;
    this.budgetExceededMessage = undefined;
    // Join the process-wide event-memory budget for the run's lifetime: this
    // run now counts toward the live-run divisor, and `trimEventBuffers`
    // squeezes this run's buffers to its fair share. Unregistered in the
    // settle `finally` alongside `captureUnsub`. Guarded so a pathological
    // double `start()` cannot register twice and permanently inflate the
    // divisor (the unregister side is guarded by the same flag).
    if (!this.eventBudgetRegistered) {
      this.eventBudget.register();
      this.eventBudgetRegistered = true;
    }
    const captureUnsub = eventBus.subscribe((ev) => {
      // Buffer only THIS run's events. `emit()` stamps every run-scoped event
      // with `runId`; queue-scoped events carry none. Without this filter
      // every controller would buffer every concurrent run's events —
      // cross-contaminating the persisted history and SSE replay, and
      // holding each event N times under N-way concurrency.
      if ((ev as { runId?: string }).runId !== this.runId) return;
      this.recentEvents.push(ev);
      this.runEventLog.push(ev);
      this.trimEventBuffers();
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

    // Audit the run lifecycle. Fire-and-forget: this hook runs inside the
    // long-lived engine, not a request about to return, and must not be
    // slowed by a disk write. `recordAudit` never throws.
    void recordAudit({
      category: 'run',
      action: 'started',
      outcome: 'info',
      actor: 'system',
      target: this.runId,
      correlationId: this.correlationId,
      detail: { workflowId: workflow.id, workflowName: workflow.name },
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

    // A tripped run-level budget aborts the run via `this.abort`, which the
    // paths above report as a user cancellation. Reclassify it as a failure
    // carrying the budget message so the persisted record names the real
    // cause rather than blaming the user.
    if (this.budgetExceededMessage) {
      finalStatus = 'failed';
      errorMessage = this.budgetExceededMessage;
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
      // Leave the event-memory budget: the run's buffers stop growing here,
      // so it must stop counting toward every other run's fair-share divisor.
      // Guarded so a future second code path cannot double-unregister.
      if (this.eventBudgetRegistered) {
        this.eventBudgetRegistered = false;
        this.eventBudget.unregister();
      }
    }

    // Snapshot every value the persist task needs RIGHT NOW. `persistRun` is
    // fire-and-forget: if a second run starts before this task gets its first
    // tick, the controller's mutable fields would already belong to the new
    // run (in the multi-run world). Capturing locals decouples the persisted
    // record from any later state change.
    const eventsForPersist = this.runEventLog.slice();
    const truncatedForPersist = this.runEventLogTruncated;
    const scopeForPersist = this.snapshot.scope;
    const costUsdForPersist = this.runCostUsd;
    const nodeCountForPersist = this.nodeExecutionCount;

    // Fold this settled run into the process-lifetime metrics counters. The
    // `run_finished` event emitted above carries the status but not the
    // duration or cost, so this is an explicit call rather than a bus
    // subscription. Synchronous and in-memory; `/api/metrics` exposes the
    // aggregate.
    metrics.recordRunSettled({
      status: finalStatus,
      durationMs: finishedAt - startedAt,
      costUsd: costUsdForPersist,
      nodeCount: nodeCountForPersist,
    });

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
      costUsd: costUsdForPersist,
      nodeCount: nodeCountForPersist,
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
    costUsd: number;
    nodeCount: number;
  }): Promise<void> {
    // Audit the run's settle independently of the history write below — the
    // audit record must survive even if `saveRun` fails. `cancelled` is
    // neither a success nor a failure of the workflow itself.
    void recordAudit({
      category: 'run',
      action: 'finished',
      outcome:
        args.status === 'succeeded'
          ? 'success'
          : args.status === 'cancelled'
            ? 'info'
            : 'failure',
      actor: 'system',
      target: args.runId,
      correlationId: this.correlationId,
      detail: {
        workflowId: args.workflow.id,
        status: args.status,
        durationMs: args.finishedAt - args.startedAt,
        ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      },
    });

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
        nodeCount: args.nodeCount,
        costUsd: args.costUsd,
        correlationId: this.correlationId,
      });
      // The run is safely in history — drop the crash-recovery marker. If
      // saveRun threw, the marker is deliberately kept so the next boot
      // reconciles this run instead of losing it.
      await removeRunMarker(args.runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('saveRun failed', { err, correlationId: this.correlationId });
      this.emit({
        type: 'error',
        message: `history not saved: ${message}`,
      });
    }
  }

  /* ─── internals ─────────────────────────────────────────────────────────── */

  /**
   * Cap both event buffers after an append. The persisted log (`runEventLog`)
   * is bounded by the tighter of its own hard cap (`PERSIST_EVENT_CAP`) and
   * the event-memory budget's fair share for the current concurrency — so a
   * burst of concurrent runs cannot grow the aggregate buffer without bound.
   * The SSE replay buffer (`recentEvents`) is then clamped to never exceed the
   * persisted log: an event dropped from the log must also drop from replay,
   * otherwise replay would pin event objects whose memory the log already
   * "freed". Oldest events are evicted first (`splice` from the front handles
   * a cap that fell by more than one between appends, e.g. when a new run
   * just joined); a persisted-log eviction sets the existing `truncated` flag.
   */
  private trimEventBuffers(): void {
    const persistCap = Math.min(
      PERSIST_EVENT_CAP,
      this.eventBudget.perRunEventCap(),
    );
    const recentCap = Math.min(EVENT_HISTORY_CAP, persistCap);
    if (this.recentEvents.length > recentCap) {
      this.recentEvents.splice(0, this.recentEvents.length - recentCap);
    }
    if (this.runEventLog.length > persistCap) {
      this.runEventLog.splice(0, this.runEventLog.length - persistCap);
      this.runEventLogTruncated = true;
    }
  }

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
   * Count one node-execution step against the run-level budget. Returns true
   * — and trips the run — when a ceiling is breached, so the caller bails out
   * of its walk immediately. Called exactly once per node step from the walk
   * loop. The single shared counter on `this` makes it a true run-level
   * ceiling: loop iterations, parallel branches and subworkflow nodes all
   * accumulate against it.
   */
  private tickBudget(): boolean {
    if (this.budgetExceededMessage) return true;
    this.nodeExecutionCount += 1;
    const { maxNodeExecutions, maxDurationMs } = this.budget;
    if (maxNodeExecutions > 0 && this.nodeExecutionCount > maxNodeExecutions) {
      this.tripBudget(
        `run aborted: node-execution budget exceeded (${maxNodeExecutions}). ` +
          'A loop is likely running away — add a maxIterations cap, or raise ' +
          'INFLOOP_MAX_RUN_NODE_EXECUTIONS.',
      );
      return true;
    }
    if (maxDurationMs > 0 && Date.now() - this.runStartedAt > maxDurationMs) {
      this.tripBudget(
        `run aborted: wall-clock budget exceeded (${maxDurationMs}ms). ` +
          'Raise or disable INFLOOP_MAX_RUN_DURATION_MS.',
      );
      return true;
    }
    return false;
  }

  /**
   * Record a budget breach and abort the run. The abort cascades to every
   * live walk (parallel-branch signals chain off `this.abort`); `start()`
   * reads `budgetExceededMessage` after settle to reclassify the run as
   * failed rather than cancelled. Idempotent — only the first breach sticks.
   */
  private tripBudget(message: string): void {
    if (this.budgetExceededMessage) return;
    this.budgetExceededMessage = message;
    this.emit({ type: 'error', message });
    this.abort.abort();
  }

  /**
   * Accumulate a settled node's provider-reported cost against both the
   * run-level cost ceiling and the process-wide cost budget, and trip the run
   * when either is breached. Called once per node from `executeNode` with the
   * raw `costUsd` off the node's outputs (only Agent nodes backed by a
   * cost-reporting provider supply one).
   *
   * MUST stay fully synchronous — no `await`. Parallel branches call this
   * concurrently; on Node's single thread an await-free read-modify-write of
   * `runCostUsd` (and of `GlobalCostBudget.spentUsd`) cannot interleave, so
   * the accumulation is race-free.
   *
   * Non-numeric / non-finite / negative values are ignored so a malformed
   * cost cannot poison the accumulator (a `NaN` would make every later
   * comparison false and silently disable the ceiling) or under-count it. A
   * legitimate `0` is skipped too — it contributes nothing, so the guard
   * uses `<= 0` purely as a harmless fast path; upstream hops keep their
   * `>= 0` filter since `0` is a valid cost to surface as an output.
   *
   * The cost is reported to the process-wide budget BEFORE the per-run check:
   * the dollar was spent regardless of which ceiling ends up tripping the run,
   * so it must always count toward the aggregate the next run is admitted
   * against. The per-run breach is reported in preference to the global one
   * when both trip on the same node — it names the tighter, run-local cause.
   */
  private recordCost(costUsd: unknown): void {
    if (this.budgetExceededMessage) return;
    if (
      typeof costUsd !== 'number' ||
      !Number.isFinite(costUsd) ||
      costUsd <= 0
    ) {
      return;
    }
    this.runCostUsd += costUsd;
    this.costBudget.add(costUsd);
    const { maxCostUsd } = this.budget;
    if (maxCostUsd > 0 && this.runCostUsd > maxCostUsd) {
      this.tripBudget(
        `run aborted: cost budget exceeded ($${maxCostUsd}). ` +
          `Accumulated provider cost reached $${this.runCostUsd.toFixed(4)} ` +
          'after the last node completed. Raise or disable ' +
          'INFLOOP_MAX_RUN_COST_USD.',
      );
      return;
    }
    if (this.costBudget.exceeded()) {
      this.tripBudget(
        'run aborted: process-wide cost budget exceeded ' +
          `($${this.costBudget.ceilingUsd}). Cumulative provider cost across ` +
          `all runs since startup reached $${this.costBudget.spent.toFixed(4)}` +
          '. Raise or disable INFLOOP_MAX_TOTAL_COST_USD.',
      );
    }
  }

  /**
   * Submit a Manual-gate decision for a parked node. Called by the
   * `/api/runs/[workflowId]/[runId]/decision` route. Returns a structured
   * result so the API can map each failure mode to a distinct status code
   * without throwing — invalid decisions, gates that never existed, and
   * gates that already settled have very different meanings to the caller.
   *
   * The `actor` string is the credential kind (mirrors `audit-log`'s
   * `actor` convention) and is persisted as `decidedBy`. We deliberately
   * never store a person's identity: Infinite Loop is single-tenant and an
   * authorized reviewer's identity lives upstream of this server.
   */
  submitDecision(opts: {
    nodeId: string;
    decision: string;
    comment?: string;
    actor: string;
  }): SubmitDecisionResult {
    if (this.snapshot.status !== 'running') {
      return { ok: false, reason: 'run-not-running' };
    }
    const pending = this.pendingDecisions.get(opts.nodeId);
    if (!pending) {
      return { ok: false, reason: 'no-pending-decision' };
    }
    const decision = opts.decision as ManualDecisionKey;
    if (!isManualDecisionKey(decision)) {
      return {
        ok: false,
        reason: 'invalid-decision',
        allowed: pending.allowed.slice(),
      };
    }
    if (!pending.allowed.includes(decision)) {
      return {
        ok: false,
        reason: 'decision-not-allowed',
        allowed: pending.allowed.slice(),
      };
    }
    const record: HumanDecisionRecord = {
      decision,
      decidedBy: opts.actor,
      decidedAt: Date.now(),
      ...(opts.comment ? { comment: opts.comment } : {}),
    };
    pending.resolve(record);
    return { ok: true, record };
  }

  /**
   * Park the run on a Manual gate, stamping `snapshot.waitingFor` and
   * emitting `node_waiting_for_human` so the UI / API / MCP can render the
   * gate. Resolves with the reviewer's decision (or a timeout-fabricated
   * one) and rejects if the run is aborted while waiting — that path turns
   * into a `cancelled` status via the existing executor error handling.
   */
  private awaitHumanDecision(opts: {
    namespacedId: string;
    brief: string;
    reviewerHint?: string;
    decisions: ManualDecisionDecl[];
    timeoutMs?: number;
    signal: AbortSignal;
  }): Promise<HumanDecisionRecord> {
    return new Promise<HumanDecisionRecord>((resolve, reject) => {
      const since = Date.now();
      const allowed = opts.decisions.map((d) => d.key);
      let settled = false;

      const cleanup = () => {
        this.pendingDecisions.delete(opts.namespacedId);
        if (this.snapshot.waitingFor?.kind === 'human' &&
            this.snapshot.waitingFor?.nodeId === opts.namespacedId) {
          // If another human gate is still pending (parallel branches each
          // parked a reviewer), promote the next one into the single-slot
          // `waitingFor` so the snapshot keeps reading as
          // `waiting_for_human` rather than briefly flipping back to plain
          // running between gates. The authoritative list lives on
          // `pendingDecisions` / `pendingHumanDecisions()`; this is just
          // the legacy single-slot mirror used by older consumers.
          const next = this.pendingDecisions.values().next();
          if (!next.done) {
            const other = next.value;
            const otherId = [...this.pendingDecisions.keys()].find(
              (k) => this.pendingDecisions.get(k) === other,
            );
            this.snapshot = {
              ...this.snapshot,
              waitingFor: {
                kind: 'human',
                nodeId: otherId ?? opts.namespacedId,
                brief: other.brief,
                reviewerHint: other.reviewerHint,
                decisions: other.decisions,
                since: other.since,
              },
            };
          } else {
            this.snapshot = { ...this.snapshot, waitingFor: undefined };
          }
        }
        opts.signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const finish = (record: HumanDecisionRecord) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.emit({
          type: 'node_human_decided',
          nodeId: opts.namespacedId,
          decision: record.decision,
          decidedBy: record.decidedBy,
          decidedAt: record.decidedAt,
          ...(record.comment ? { comment: record.comment } : {}),
          ...(record.timedOut ? { timedOut: true } : {}),
        });
        resolve(record);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        // Run cancelled or budget-tripped while parked. Reject so the
        // executor's caller (executeNode) routes through the existing
        // abort / signal-aware error path.
        fail(new Error('manual gate aborted'));
      };

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        // Timeout falls back to `rejected` so a forgotten gate fails closed
        // — the deploy/incident-response convention. The fabricated record
        // is persisted exactly like a human submission, with `timedOut`
        // set so audit / UI can distinguish.
        timer = setTimeout(() => {
          finish({
            decision: 'rejected',
            decidedBy: 'system:timeout',
            decidedAt: Date.now(),
            timedOut: true,
          });
        }, opts.timeoutMs);
      }

      if (opts.signal.aborted) {
        // Already cancelled before we got here — fail synchronously without
        // recording state. (`cleanup` is safe to call even if `pendingDecisions`
        // never held an entry for this nodeId.)
        fail(new Error('manual gate aborted'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });

      this.pendingDecisions.set(opts.namespacedId, {
        brief: opts.brief,
        reviewerHint: opts.reviewerHint,
        decisions: opts.decisions,
        allowed,
        since,
        resolve: finish,
      });

      this.snapshot = {
        ...this.snapshot,
        waitingFor: {
          kind: 'human',
          nodeId: opts.namespacedId,
          brief: opts.brief,
          reviewerHint: opts.reviewerHint,
          decisions: opts.decisions,
          since,
        },
      };

      this.emit({
        type: 'node_waiting_for_human',
        nodeId: opts.namespacedId,
        brief: opts.brief,
        ...(opts.reviewerHint ? { reviewerHint: opts.reviewerHint } : {}),
        decisions: opts.decisions,
      });
    });
  }

  /**
   * Snapshot every Manual-gate this run is currently parked on. The
   * `/api/runs` list endpoint uses this so an operator can spot stuck gates
   * across runs without polling every detail endpoint.
   */
  pendingHumanDecisions(): Array<{
    nodeId: string;
    brief: string;
    reviewerHint?: string;
    decisions: ManualDecisionDecl[];
    since: number;
  }> {
    const out: Array<{
      nodeId: string;
      brief: string;
      reviewerHint?: string;
      decisions: ManualDecisionDecl[];
      since: number;
    }> = [];
    for (const [nodeId, pending] of this.pendingDecisions) {
      out.push({
        nodeId,
        brief: pending.brief,
        reviewerHint: pending.reviewerHint,
        decisions: pending.decisions,
        since: pending.since,
      });
    }
    return out;
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
      // `signal.aborted` short-circuits so a node step is NOT counted once a
      // run is already settling; otherwise `tickBudget` counts this step and
      // trips the run if a ceiling is now breached.
      if (signal.aborted || this.tickBudget()) return 'cancelled';

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

      const branch = await this.executeNode(current, exec, scope, workflow, signal);

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
    // `infinite: true` removes the per-loop cap; the run-level budget
    // (see `tickBudget`) is the backstop that still bounds the whole run.
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
    workflow: Workflow,
    signal: AbortSignal,
  ): Promise<EdgeHandle> {
    const executor = this.executors[node.type];
    if (!executor) throw new Error(`unknown node type: ${node.type}`);

    const { resolved: resolvedConfig, criticalMisses } =
      this.resolveConfigTemplates(node, scope, exec);
    const namespacedId = this.namespaced(node.id, exec);

    this.emit({
      type: 'node_started',
      nodeId: namespacedId,
      nodeType: node.type,
      resolvedConfig,
      loopIteration: exec.loopIteration,
    });

    const cwd = resolveExecutionCwd(
      workflow.cwd,
      (resolvedConfig as { cwd?: unknown }).cwd,
    );

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
      awaitHumanDecision: (opts) =>
        this.awaitHumanDecision({
          namespacedId,
          brief: opts.brief,
          reviewerHint: opts.reviewerHint,
          decisions: opts.decisions,
          timeoutMs: opts.timeoutMs,
          signal,
        }),
    };

    let result;
    if (criticalMisses.length > 0) {
      // A required templated field had an unresolved `{{...}}` reference.
      // Fail the node loudly onto its `error` branch rather than letting the
      // executor run on a silently degraded value — see CRITICAL_CONFIG_FIELDS.
      // Dedup: `resolve()` reports one warning per `{{...}}` occurrence, so a
      // field that repeats the same missing reference would otherwise list it
      // twice in this operator-facing message.
      const detail = [
        ...new Set(criticalMisses.map((m) => `${m.field} ({{${m.missingKey}}})`)),
      ].join(', ');
      const message = `unresolved template reference in required field: ${detail}`;
      this.emit({ type: 'error', nodeId: namespacedId, message });
      result = { outputs: { errorMessage: message }, branch: 'error' as EdgeHandle };
    } else {
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
    }

    scope[node.id] = result.outputs;
    // Charge any provider-reported cost against the run-level cost ceiling.
    // Post-execution by necessity — cost is only known once the node has run
    // — so this can only trip *after* the offending node; `tripBudget` then
    // aborts and the walk halts at its next step.
    this.recordCost((result.outputs as { costUsd?: unknown }).costUsd);
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
  ): {
    resolved: Record<string, unknown>;
    criticalMisses: Array<{ field: string; missingKey: string }>;
  } {
    const fields = TEXT_CONFIG_FIELDS[node.type] ?? [];
    const criticalFields = CRITICAL_CONFIG_FIELDS[node.type] ?? [];
    const cfg = node.config as Record<string, unknown>;
    const resolved: Record<string, unknown> = { ...cfg };
    const criticalMisses: Array<{ field: string; missingKey: string }> = [];
    for (const field of fields) {
      const raw = cfg[field];
      if (typeof raw === 'string') {
        const { text, warnings } = resolveTemplate(raw, scope);
        resolved[field] = text;
        const isCritical = criticalFields.includes(field);
        for (const w of warnings) {
          if (isCritical) {
            // Defer to the loud `error` event raised in `executeNode`; a
            // `template_warning` here too would just be redundant noise.
            criticalMisses.push({ field, missingKey: w.missingKey });
            continue;
          }
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
    return { resolved, criticalMisses };
  }
}
