/*
 * Workflow contract — IMMUTABLE for Phase B workers.
 * All node executors, the engine, the canvas, and the API talk through these types.
 */

export type NodeType =
  | 'start'
  | 'end'
  | 'agent'
  | 'condition'
  | 'loop'
  | 'branch'
  | 'parallel'
  | 'subworkflow'
  | 'structured-output'
  | 'sidenote'
  | 'script'
  | 'manual';

/** Edge handles. Workers MUST emit one of these from a node executor. */
export type EdgeHandle =
  | 'next'
  | 'met'
  | 'not_met'
  | 'true'
  | 'false'
  | 'error'
  | 'continue'
  | 'break'
  | 'all_done'
  | 'first_done'
  | 'quorum_met'
  // Manual / human-acceptance gate decision handles. Routed by the manual
  // node executor based on the reviewer's submitted decision.
  | 'accepted'
  | 'needs_changes'
  | 'rejected';

/** Decision keys an authorized reviewer may pick on a Manual node. The
 *  three conventional values double as their outgoing edge handles. */
export type ManualDecisionKey = 'accepted' | 'needs_changes' | 'rejected';

export const MANUAL_DECISION_KEYS: readonly ManualDecisionKey[] = [
  'accepted',
  'needs_changes',
  'rejected',
];

/** Default decision set surfaced when a Manual node omits `decisions`. */
export const MANUAL_DEFAULT_DECISIONS: readonly ManualDecisionKey[] = [
  'accepted',
  'needs_changes',
  'rejected',
];

export type ConditionKind = 'sentinel' | 'command' | 'judge';

export interface SentinelConfig {
  pattern: string;
  isRegex: boolean;
  caseInsensitive?: boolean;
}

export interface CommandConfig {
  cmd: string;
}

export interface JudgeConfig {
  rubric: string;
  model?: string;
}

export interface StartConfig {}

export interface EndConfig {
  outcome?: 'succeeded' | 'failed';
}

/** Roles accepted by the OpenAI Responses API for a conversational input. */
export type AgentMessageRole = 'system' | 'user' | 'assistant';

/** One ordered conversational turn configured on an Agent node. */
export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
}

export interface AgentConfig {
  /** Provider id resolved against `providers/*.json`, e.g. "claude" or "codex". */
  providerId: string;
  /**
   * Legacy single user prompt. Kept for persisted workflows created before
   * `messages`; when `messages` is absent it is treated as one user message.
   */
  prompt: string;
  /** Ordered system, user, and assistant turns. HTTP providers preserve these
   * roles; CLI providers receive an explicitly labelled transcript. */
  messages?: AgentMessage[];
  /** Optional node-specific working-directory override. Falls back to the
   * workflow's `cwd`, then `/tmp`. */
  cwd?: string;
  timeoutMs: number;
  /** Optional model/profile name. HTTP providers use it as the request model
   * (falling back to the manifest's `defaultProfile`). CLI providers may use
   * it when their manifest declares a `{profile}` argument placeholder. */
  profile?: string;
  /** Optional model name for CLI providers. Passed to the CLI only when its
   * manifest declares a `{model}` argument placeholder. Leave blank to omit it. */
  model?: string;
  /** Optional subagent name. Only meaningful for the Claude CLI provider — it
   * becomes `--agent <name>` on the spawned command. When unset, the flag is
   * omitted entirely. Other providers ignore this field. */
  agent?: string;
  /** When true, the engine creates a fresh git worktree off `cwd` and spawns
   * the CLI there instead of in `cwd` itself, so parallel agents can edit the
   * same repo without stepping on each other. The worktree is created when
   * the node first runs in a given run and removed at run end. CLI-transport
   * providers only — HTTP providers ignore this. */
  useWorktree?: boolean;
  /** Optional templated git ref (branch / commit / tag) the worktree is based
   * on. Falls back to HEAD of `cwd`. Only meaningful when `useWorktree` is
   * true. NOTE: uncommitted edits in `cwd` are NOT carried into the worktree
   * — commit or stash first if you want the agent to see them. */
  worktreeRef?: string;
  /** When true, the agent CLI runs with every tool-permission prompt
   * disabled — full autonomous file, shell, and network access (the Claude
   * CLI's `--dangerously-skip-permissions`). Off by default: a missing or
   * false value runs the CLI with its normal permission posture, so a child
   * spawned from an untrusted prompt cannot act without the operator opting
   * in. Only enable for trusted prompts, ideally inside the sandboxed
   * container. CLI-transport providers only — HTTP providers ignore it. */
  dangerouslySkipPermissions?: boolean;
  /** Declared named outputs the agent may emit via the injected SetOutput
   * MCP server (`set_output({ key, value })`). On agent exit, recorded
   * values flatten into this node's outputs map alongside `stdout` /
   * `stderr` / `exitCode` / etc., so downstream nodes read them as
   * `{{<node-id>.<name>}}`. When empty or undefined, no MCP server is
   * injected. Names collide-checked against agent-runtime keys at workflow
   * save (see lib/server/workflow-store.ts validateNodeConfig). */
  outputs?: AgentOutputDecl[];
}

export interface AgentOutputDecl {
  /** Output key the agent will pass as `set_output({ key })`. */
  name: string;
  /** Optional per-output description; surfaced to the agent in the
   * SetOutput tool's overall description so it knows what each key is for. */
  description?: string;
}

/** Output keys reserved by the agent runtime — see lib/server/nodes/agent.ts.
 * Declared outputs must not collide with these (validated at workflow save). */
export const AGENT_RESERVED_OUTPUT_NAMES: readonly string[] = [
  'stdout',
  'stderr',
  'exitCode',
  'durationMs',
  'timedOut',
  'worktreePath',
  'errorMessage',
  'costUsd',
];

/** Validate the declared-outputs shape on an Agent node. Pure (no IO) so the
 * UI can call it for live form validation and the server can call it during
 * `saveWorkflow`. Throws with a stable, user-facing message — keep the
 * wording stable; tests and the workflow-store loader assert on it.
 *
 * Accepts `undefined` (no outputs declared) as valid. `nodeId` is woven into
 * the error message for save-time diagnostics. */
export function validateAgentOutputs(
  outputs: unknown,
  nodeId: string,
): void {
  if (outputs === undefined) return;
  if (!Array.isArray(outputs)) {
    throw new Error(
      `invalid workflow: agent node "${nodeId}" outputs must be an array`,
    );
  }
  const seen = new Set<string>();
  const reserved = new Set(AGENT_RESERVED_OUTPUT_NAMES);
  for (const decl of outputs as unknown[]) {
    if (
      !decl ||
      typeof decl !== 'object' ||
      typeof (decl as { name?: unknown }).name !== 'string' ||
      (decl as { name: string }).name.length === 0
    ) {
      throw new Error(
        `invalid workflow: agent node "${nodeId}" outputs entries must be { name: string, description?: string }`,
      );
    }
    const name = (decl as { name: string }).name;
    if (seen.has(name)) {
      throw new Error(
        `invalid workflow: agent node "${nodeId}" declares duplicate output "${name}"`,
      );
    }
    if (reserved.has(name)) {
      throw new Error(
        `invalid workflow: agent node "${nodeId}" output "${name}" collides with a reserved runtime field`,
      );
    }
    seen.add(name);
  }
}

export interface ConditionConfig {
  kind: ConditionKind;
  /**
   * Templating-resolved string the strategy evaluates. If unset, the engine
   * defaults to `{{<incoming-source>.stdout}}`.
   */
  against?: string;
  sentinel?: SentinelConfig;
  command?: CommandConfig;
  judge?: JudgeConfig;
}

export interface LoopConfig {
  maxIterations: number;
  /** 'while-not-met' is the default common case; 'unbounded' relies on break. */
  mode: 'while-not-met' | 'unbounded';
  /**
   * When true, the engine ignores `maxIterations` and iterates without a cap.
   * The body is expected to exit via `break`, an `end` node, or run cancel.
   */
  infinite?: boolean;
}

export type BranchOp = '==' | '!=' | 'contains' | 'matches';

export interface BranchConfig {
  /** Templating-resolved left-hand side (e.g. `{{shell-1.exitCode}}`). */
  lhs: string;
  op: BranchOp;
  /** Templating-resolved right-hand side. For `matches`, this is a regex source. */
  rhs: string;
  /** When true, comparisons ignore ASCII case: ==/!= use lowercased operands,
   * contains uses lowercased substring search, matches sets the regex `i` flag. */
  caseInsensitive?: boolean;
}

export type ParallelMode = 'wait-all' | 'race' | 'quorum';
export type ParallelOnError = 'fail-fast' | 'best-effort';

export interface ParallelConfig {
  /** wait-all → 'all_done' on success. race → 'first_done' on first success
   * (siblings cancel). quorum → 'quorum_met' once `quorumN` branches finish
   * successfully (rest cancel). All modes route 'error' on failure. */
  mode: ParallelMode;
  /** Required when mode === 'quorum'. Must satisfy 1 ≤ quorumN ≤ children.length. */
  quorumN?: number;
  /** fail-fast: any branch error cancels siblings and routes 'error'.
   * best-effort: collect per-branch errors; route success handle if mode's
   * success criterion is still met by surviving branches; otherwise 'error'. */
  onError: ParallelOnError;
}

export interface SubworkflowConfig {
  /** Workflow id (filename stem) of the child workflow to run. */
  workflowId: string;
  /** Input bindings: each value is a templated string evaluated against parent
   * scope. Inside the child run, these surface under scope.__inputs.<name>. */
  inputs: Record<string, string>;
  /** Output bindings: parentName → dotted child-scope path (e.g.
   * "agent-1.stdout"). Each value is copied from the child's terminal scope
   * back into parent scope under this subworkflow node's id. */
  outputs: Record<string, string>;
}

export interface SidenoteConfig {
  /** Free-form note text shown on the canvas. Static — not templated. */
  text: string;
}

export type ScriptLanguage = 'ts' | 'py';

export interface ScriptConfig {
  /** 'ts' → run via Bun; 'py' → run via python3. Interpreter binaries are
   * configurable through `INFLOOP_BUN_BIN` / `INFLOOP_PYTHON_BIN`. */
  language: ScriptLanguage;
  /** Ordered named inputs. Each value is a templated string; the resolved
   * values are passed to the user's `run(...)` function as positional args
   * in declaration (insertion) order. Record key order is preserved by
   * modern JS engines for string keys. */
  inputs: Record<string, string>;
  /** Declared output names. The user's function returns an object; for
   * each name listed here, that key is pulled from the return value and
   * placed in this node's scope under the same name. Undeclared keys are
   * ignored. */
  outputs: string[];
  /** Inline source. Must define a top-level `run(arg1, arg2, …)` function
   * accepting the inputs (in order) and returning an object whose keys
   * include each declared output. NOT templated — write template
   * literals / f-strings freely. */
  code: string;
  /** Templated working directory override. Falls back to the engine's
   * `defaultCwd` when unset or blank. */
  cwd?: string;
  /** Per-run timeout. 0 disables the timer. */
  timeoutMs?: number;
}

export interface ManualDecisionDecl {
  /** Decision key — becomes the outgoing edge handle when chosen. Must be
   *  one of the conventional `accepted` / `needs_changes` / `rejected`
   *  values; the type stays narrow so workflow edges remain typeable. */
  key: ManualDecisionKey;
  /** Optional human-readable label shown to the reviewer (e.g. "Ship it",
   *  "Send back"). Falls back to a title-cased version of `key`. */
  label?: string;
  /** Optional one-liner shown beneath the button. */
  description?: string;
}

export interface ManualConfig {
  /** Optional human-readable brief shown to the reviewer above the decision
   *  buttons. Templated — typical use is summarizing the work upstream nodes
   *  produced, e.g. "Review {{agent-1.stdout}} for correctness". */
  brief?: string;
  /** Optional one-line hint identifying who is expected to decide
   *  (e.g. "on-call SRE", "release captain"). Free-form text, NOT identity:
   *  Infinite Loop is single-tenant by design, so this is operator
   *  guidance only — the API doesn't enforce it. */
  reviewerHint?: string;
  /** Decision set the reviewer may pick from. Defaults to all three
   *  conventional decisions when omitted. Order is preserved for the UI. */
  decisions?: ManualDecisionDecl[];
  /** Optional ms cap on how long the gate may wait. When the budget is
   *  exceeded, the node settles on the `rejected` handle with
   *  `timedOut: true`. `0` or unset = wait forever (the run-level
   *  duration budget still applies). */
  timeoutMs?: number;
}

/** Validate a Manual node's decision list. Pure (no IO) so the UI can call
 *  it for live form validation and the server calls it at workflow save.
 *  Throws with stable, user-facing messages — tests assert on the wording. */
export function validateManualDecisions(
  decisions: unknown,
  nodeId: string,
): void {
  if (decisions === undefined) return;
  if (!Array.isArray(decisions)) {
    throw new Error(
      `invalid workflow: manual node "${nodeId}" decisions must be an array`,
    );
  }
  if (decisions.length === 0) {
    throw new Error(
      `invalid workflow: manual node "${nodeId}" decisions must list at least one entry`,
    );
  }
  const seen = new Set<string>();
  const allowed = new Set<string>(MANUAL_DECISION_KEYS);
  for (const decl of decisions as unknown[]) {
    if (
      !decl ||
      typeof decl !== 'object' ||
      typeof (decl as { key?: unknown }).key !== 'string'
    ) {
      throw new Error(
        `invalid workflow: manual node "${nodeId}" decisions entries must be { key: string, label?: string, description?: string }`,
      );
    }
    const key = (decl as { key: string }).key;
    if (!allowed.has(key)) {
      throw new Error(
        `invalid workflow: manual node "${nodeId}" decision key "${key}" must be one of ${[...allowed].join(', ')}`,
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `invalid workflow: manual node "${nodeId}" declares duplicate decision "${key}"`,
      );
    }
    seen.add(key);
  }
}

/** One OpenAI-compatible, strict-JSON-Schema completion. The provider id
 * resolves through the existing HTTP-provider manifests; credentials never
 * live in workflow JSON. */
export interface StructuredOutputConfig {
  providerId: string;
  /** HTTP provider model override; falls back to the manifest default. */
  profile?: string;
  /** Templated user message sent in the single completion request. */
  prompt: string;
  /** JSON Schema object sent as `text.format.schema` in the Responses API. */
  schema: Record<string, unknown>;
  timeoutMs: number;
}
export type NodeConfigByType = {
  start: StartConfig;
  end: EndConfig;
  agent: AgentConfig;
  condition: ConditionConfig;
  loop: LoopConfig;
  branch: BranchConfig;
  parallel: ParallelConfig;
  subworkflow: SubworkflowConfig;
  'structured-output': StructuredOutputConfig;
  sidenote: SidenoteConfig;
  script: ScriptConfig;
  manual: ManualConfig;
};

export interface WorkflowNode<T extends NodeType = NodeType> {
  id: string;
  type: T;
  position: { x: number; y: number };
  config: NodeConfigByType[T];
  /**
   * Container nodes (currently only `loop`) hold their child nodes here. Edges
   * inside a container reference these child ids and live in the parent
   * workflow's `edges` array (the engine resolves which container an edge
   * belongs to by source/target id).
   */
  children?: WorkflowNode[];
  /** Optional human-readable label override for the canvas. */
  label?: string;
  /** Optional persisted canvas size (currently used by Loop containers so
   * the user can resize them; xyflow's NodeResizer writes here). */
  size?: { width: number; height: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle: EdgeHandle;
  target: string;
  /** Usually 'in'; container nodes may have multiple inputs. */
  targetHandle?: string;
}

/** Type of a Begin-node–declared input. `text` is multiline string;
 * all other values are stored exactly as their JS primitive. */
export type WorkflowInputType = 'string' | 'number' | 'boolean' | 'text';

/** Per-run input declared on the workflow root. The Begin (Start) node's
 * config panel edits the workflow-level `inputs` array. Callers supply
 * values via /api/run or via the subworkflow executor; if `default` is
 * omitted the input is required. */
export interface WorkflowInputDecl {
  /** Identifier used in templates as `{{inputs.NAME}}`. Must match
   *  /^[a-zA-Z_][a-zA-Z0-9_]*$/ and be unique within the workflow. */
  name: string;
  type: WorkflowInputType;
  /** If omitted, the input is required: callers must supply a value
   *  or the run is rejected before it starts. */
  default?: string | number | boolean;
  description?: string;
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
  /** Optional workflow-wide working directory. Nodes with their own `cwd`
   * override this; when neither is set, execution falls back to `/tmp`. */
  cwd?: string;
  /** Workflow-level custom globals. Each entry's value is a literal
   * string (NOT templated — globals don't reference each other). At run
   * time the engine merges them into the scope under the `globals` key,
   * so any node can reference `{{globals.NAME}}`. */
  globals?: Record<string, string>;
  /** Ordered list of Begin-node input declarations. At run time the
   * engine seeds resolved values into the scope under the `inputs` key
   * so any node can reference `{{inputs.NAME}}`. Unlike `globals`, the
   * values come from the caller (API/subworkflow/UI), not from the
   * workflow JSON. */
  inputs?: WorkflowInputDecl[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  /** Where the file lives. 'library' = repo-shipped read-only preset; 'user'
   * = user-editable workflow under the storage dir. Optional for back-compat
   * with older clients that ignore the field. */
  source?: 'user' | 'library';
}

/* ─── runtime state ───────────────────────────────────────────────────────── */

export type RunStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Variable scope for a single run. Keyed by node id; node executors write here. */
export type Scope = Record<string, Record<string, unknown>>;

export interface RunSnapshot {
  status: RunStatus;
  /** Stable id of the current or most-recent run. Set on `start()`,
   *  preserved on terminal statuses, overwritten by the next `start()`.
   *  `undefined` only on a fresh engine that has never run anything. */
  runId?: string;
  workflowId?: string;
  currentNodeId?: string;
  iterationByLoopId: Record<string, number>;
  scope: Scope;
  startedAt?: number;
  finishedAt?: number;
  errorMessage?: string;
  /**
   * Recent events emitted during the current/last run, capped to a sliding
   * window. Returned by getState() so a refreshing client can rehydrate the
   * event log and the canvas's live-node highlight.
   */
  events?: WorkflowEvent[];
  /**
   * When a node is parked waiting for an external signal: a directory lock,
   * a concurrency slot, or a human acceptance decision. Set when the wait
   * begins (alongside the matching node_waiting_for_* event), cleared when
   * the wait resolves (acquired / decision submitted) or aborts (cancelled
   * or LockCycleError). The run's status stays 'running' throughout — this
   * field is the observability hook for "running, but not progressing".
   *
   * The `human` kind also surfaces the reviewer-facing brief / decision set
   * so a polling client (UI / CLI / MCP) can render the gate without
   * loading the workflow definition separately. The same wire shape is
   * mirrored on the `node_waiting_for_human` event.
   */
  waitingFor?: {
    kind: 'lock' | 'slot' | 'human';
    nodeId: string;
    /** The canonical path the waiter wants. Present when `kind === 'lock'`. */
    path?: string;
    /** Identity of the run currently holding the conflicting path. Present
     *  when `kind === 'lock'`. */
    heldByRunId?: string;
    /** The canonical path the holder is locking. Distinct from `path` when
     *  the conflict is ancestor/descendant. */
    heldByPath?: string;
    /** Template-resolved brief shown to the reviewer. Present when
     *  `kind === 'human'`. */
    brief?: string;
    /** Optional template-resolved reviewer-audience hint. Present when
     *  `kind === 'human'`. */
    reviewerHint?: string;
    /** Decisions the reviewer may pick from. Present when
     *  `kind === 'human'`. */
    decisions?: ManualDecisionDecl[];
    /** Epoch-ms timestamp when the gate began waiting. Present when
     *  `kind === 'human'`. */
    since?: number;
  };
}

/* ─── events on the WS bus ────────────────────────────────────────────────── */

// Run-scoped events. `runId` and `correlationId` are stamped by
// `RunController.emit` at emit time — executors and walk methods never set
// them themselves. The optional shape keeps the legacy single-run consumers
// compiling and lets the literal at each `emit()` call site omit them; under
// multi-run, every event reaching SSE consumers carries both. The correlation
// id ties the run back to the ingress event that started it — see
// lib/server/correlation.ts.

export interface RunStartedEvent {
  type: 'run_started';
  runId?: string;
  correlationId?: string;
  workflowId: string;
  workflowName: string;
}

export interface NodeStartedEvent {
  type: 'node_started';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  nodeType: NodeType;
  /** The fully template-resolved config the executor is about to receive. */
  resolvedConfig: Record<string, unknown>;
  /** Loop iteration index, if this node is inside a Loop container. */
  loopIteration?: number;
}

export interface NodeFinishedEvent {
  type: 'node_finished';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  nodeType: NodeType;
  branch: EdgeHandle;
  /** What the executor wrote into the scope under its node id. */
  outputs: Record<string, unknown>;
  durationMs: number;
}

export interface StdoutChunkEvent {
  type: 'stdout_chunk';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  line: string;
  /** Optional loop iteration the chunk belongs to. */
  loopIteration?: number;
}

export interface ConditionCheckedEvent {
  type: 'condition_checked';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  met: boolean;
  detail: string;
}

export interface TemplateWarningEvent {
  type: 'template_warning';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  field: string;
  missingKey: string;
}

// ErrorEvent is dual-scoped:
//   - emitted inside a run via controller.emit → carries runId
//   - emitted from queue/admin paths via eventBus.emit direct → no runId
export interface ErrorEvent {
  type: 'error';
  runId?: string;
  correlationId?: string;
  nodeId?: string;
  message: string;
  stderr?: string;
}

export interface RunFinishedEvent {
  type: 'run_finished';
  runId?: string;
  correlationId?: string;
  status: Exclude<RunStatus, 'idle' | 'running'>;
  scope: Scope;
}

// Stage 4 (DirLockManager wiring) emits these. Defined now so the type lands
// with the rest of the event-tagging work in stage 2.

export interface NodeWaitingForLockEvent {
  type: 'node_waiting_for_lock';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  path: string;
  heldByRunId: string;
  /** The canonical path the holder is currently locking. Distinct from
   *  `path` in the ancestor/descendant-conflict cases — e.g. waiter wants
   *  `/proj/sub` and holder owns `/proj`. */
  heldByPath: string;
}

export interface NodeLockAcquiredEvent {
  type: 'node_lock_acquired';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  path: string;
}

export interface NodeWaitingForSlotEvent {
  type: 'node_waiting_for_slot';
  runId?: string;
  correlationId?: string;
  nodeId: string;
}

export interface NodeSlotAcquiredEvent {
  type: 'node_slot_acquired';
  runId?: string;
  correlationId?: string;
  nodeId: string;
}

// Manual / human-acceptance gate events. `node_waiting_for_human` fires when
// a manual node parks (after `node_started`); `node_human_decided` fires when
// an authorized reviewer submits a decision (just before `node_finished`).

export interface NodeWaitingForHumanEvent {
  type: 'node_waiting_for_human';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  /** Template-resolved brief shown to the reviewer. */
  brief: string;
  /** Optional reviewer-audience hint, template-resolved. */
  reviewerHint?: string;
  /** Decisions the reviewer may pick. Mirrors `snapshot.waitingFor.decisions`
   *  so SSE consumers can render without a separate workflow fetch. */
  decisions: ManualDecisionDecl[];
}

export interface NodeHumanDecidedEvent {
  type: 'node_human_decided';
  runId?: string;
  correlationId?: string;
  nodeId: string;
  decision: ManualDecisionKey;
  /** Coarse actor that authenticated the decision submission (mirrors
   *  audit-log conventions: 'api-token' | 'browser-session' | 'open'). */
  decidedBy: string;
  /** Epoch-ms timestamp the decision was recorded server-side. */
  decidedAt: number;
  /** Optional free-form reviewer comment. */
  comment?: string;
  /** True when the decision came from a timeout firing rather than a
   *  human submitting. Carries `decision: 'rejected'` by convention. */
  timedOut?: boolean;
}

// Queue-scoped events. Emitted directly from trigger-queue.ts (not via
// RunController.emit), so each `eventBus.emit` call site sets `correlationId`
// explicitly from the queued run. Optional on the type for uniformity with the
// run events above.

export interface TriggerEnqueuedEvent {
  type: 'trigger_enqueued';
  queueId: string;
  triggerId: string;
  workflowId: string;
  correlationId?: string;
  inputs?: Record<string, string | number | boolean>;
  position: number;
  receivedAt: number;
}

export interface TriggerStartedEvent {
  type: 'trigger_started';
  queueId: string;
  triggerId: string;
  workflowId: string;
  correlationId?: string;
  runId: string;
}

export interface TriggerDroppedEvent {
  type: 'trigger_dropped';
  queueId: string;
  triggerId: string;
  correlationId?: string;
  reason: 'workflow-deleted' | 'queue-full' | 'engine-start-failed';
}

export interface TriggerRemovedEvent {
  type: 'trigger_removed';
  queueId: string;
  triggerId: string;
  workflowId: string;
  correlationId?: string;
  reason: 'user-cancelled';
}

export type WorkflowEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeFinishedEvent
  | StdoutChunkEvent
  | ConditionCheckedEvent
  | TemplateWarningEvent
  | ErrorEvent
  | RunFinishedEvent
  | NodeWaitingForLockEvent
  | NodeLockAcquiredEvent
  | NodeWaitingForSlotEvent
  | NodeSlotAcquiredEvent
  | NodeWaitingForHumanEvent
  | NodeHumanDecidedEvent
  | TriggerEnqueuedEvent
  | TriggerStartedEvent
  | TriggerDroppedEvent
  | TriggerRemovedEvent;

export type WsStatus = 'connecting' | 'open' | 'closed';

/* ─── run history (persisted) ────────────────────────────────────────────── */

/** A finished run's terminal state. Excludes the live transitional values. */
export type TerminalRunStatus = Exclude<RunStatus, 'idle' | 'running'>;

/** Full record of one completed run, written once at settle. */
export interface RunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: TerminalRunStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  scope: Scope;
  errorMessage?: string;
  events: WorkflowEvent[];
  /** True when the event log was truncated mid-run because it exceeded the
   * persistence cap (e.g. an infinite loop with chatty stdout). The events
   * array still ends at the cap; older events are dropped first. */
  truncated?: boolean;
  /** Total node-execution steps the run took — RunController's run-level
   * budget counter at settle. Optional: absent on records written before
   * this field existed. */
  nodeCount?: number;
  /** Cumulative provider-reported cost of the run, in USD. Only Agent nodes
   * backed by a cost-reporting provider (currently the `claude` CLI)
   * contribute; `0` for a run that incurred none. Optional: absent on
   * records written before this field existed. */
  costUsd?: number;
  /** Correlation id of the ingress event that started this run — ties the
   * record back to the webhook / API / MCP call and its audit entries. See
   * lib/server/correlation.ts. Optional: absent on records written before
   * this field existed. */
  correlationId?: string;
}

/** Lightweight projection used by list endpoints / UI menus. */
export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: TerminalRunStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  errorMessage?: string;
  eventCount: number;
  truncated?: boolean;
  /** See `RunRecord.nodeCount`. Carried through so list views can surface it
   * without fetching each full record. Absent on pre-existing records. */
  nodeCount?: number;
  /** See `RunRecord.costUsd`. Absent on pre-existing records. */
  costUsd?: number;
  /** See `RunRecord.correlationId`. Absent on pre-existing records. */
  correlationId?: string;
}

/* ─── node executor contract ──────────────────────────────────────────────── */

/**
 * Per-run helper handed to node executors that opt into git worktrees. The
 * engine constructs one instance per run and calls `cleanupAll()` once the
 * run settles. Executors call `create()` per node — repeated calls with the
 * same `nodeId` within a single run reuse the same path (so a Loop body
 * doesn't accumulate a worktree per iteration).
 */
export interface RunWorktrees {
  create(opts: {
    repoPath: string;
    ref?: string;
    nodeId: string;
  }): Promise<string>;
  cleanupAll(): Promise<void>;
}

export interface NodeExecutorContext {
  /** Current run id. Used by executors that mint per-run resources (e.g.
   * the SetOutput MCP token registry) and need a run-scoped key for sweep
   * on settle. Optional for back-compat with unit-test contexts that
   * hand-build the ctx without an engine. */
  runId?: string;
  /** This node's id within its workflow. Used by executors that need to key
   * per-run resources (e.g. worktrees) by node identity. Optional for
   * back-compat with unit-test contexts that hand-build the ctx. */
  nodeId?: string;
  /** Already-template-resolved config for this node. */
  config: unknown;
  /** Read-only flat scope of all prior nodes' outputs. */
  scope: Scope;
  /** Caller cwd for filesystem-touching nodes; nodes may override via config. */
  defaultCwd: string;
  /** Aborted when the user clicks Stop. */
  signal: AbortSignal;
  /** Loop iteration index if this node is inside a Loop container. */
  loopIteration?: number;
  /** Stream a stdout line back to the bus (Claude/Shell nodes). */
  emitStdoutChunk?: (line: string) => void;
  /** Per-run worktree manager. Present only when the engine drives the run;
   * unit-test contexts may omit it. Agent nodes use it when `useWorktree`
   * is set. */
  runWorktrees?: RunWorktrees;
  /**
   * Acquire a per-run directory lock for `path`. Resolves to an idempotent
   * release fn. Handles slot admission and FIFO waits internally; emits
   * `node_waiting_for_lock` / `node_lock_acquired` events as needed.
   * CLI-transport agents wrap their spawn in this; HTTP agents skip it.
   * Optional for back-compat with unit-test contexts that omit the engine.
   */
  acquireDirLock?: (opts: { path: string; signal?: AbortSignal }) => Promise<() => void>;
  /**
   * Register a canonical absolute path as exempt from directory locking for
   * the lifetime of the current run. Returns a deregister fn for early
   * release. Used by Agent nodes when worktree-mode is on: the worktree
   * path is run-scoped and inherently isolated, so it never enters the
   * lock manager's bookkeeping.
   */
  registerExempt?: (canonicalPath: string) => () => void;
  /**
   * Park the run until an authorized reviewer submits a decision for this
   * Manual gate. The controller stamps `snapshot.waitingFor.kind = 'human'`
   * with the brief / decision set, emits `node_waiting_for_human`, and
   * resolves the promise once a matching `controller.submitDecision()`
   * arrives — or rejects if the run is aborted first. Implementations live
   * in `RunController` (production) and test harnesses; node executors
   * outside the manual node should not call this.
   *
   * Optional for back-compat with unit-test contexts that hand-build the
   * ctx without an engine. The manual executor surfaces a clear error when
   * the engine forgot to plumb it through.
   */
  awaitHumanDecision?: (opts: {
    brief: string;
    reviewerHint?: string;
    decisions: ManualDecisionDecl[];
    timeoutMs?: number;
  }) => Promise<HumanDecisionRecord>;
}

/** Persisted record of one Manual-gate decision. Written to scope and
 *  surfaced on `node_human_decided`; the run record's `scope` keeps it as
 *  the node's outputs so a workflow author can reference downstream as
 *  `{{<manual-id>.decision}}` etc. */
export interface HumanDecisionRecord {
  decision: ManualDecisionKey;
  decidedBy: string;
  decidedAt: number;
  comment?: string;
  /** True when the controller fabricated the decision because the gate's
   *  timeout elapsed before a reviewer submitted. */
  timedOut?: boolean;
}

export interface NodeExecutorResult {
  /** Variables this node wrote — merged into scope under the node's id. */
  outputs: Record<string, unknown>;
  /** Which outgoing edge handle to follow next. */
  branch: EdgeHandle;
}

export interface NodeExecutor {
  execute(ctx: NodeExecutorContext): Promise<NodeExecutorResult>;
}

/* ─── templating result type (Phase B U1) ─────────────────────────────────── */

export interface TemplateResolveResult {
  text: string;
  warnings: Array<{ field: string; missingKey: string }>;
}
