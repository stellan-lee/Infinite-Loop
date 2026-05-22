/*
 * Template-ref registry — what `{{nodeId.field}}` references a workflow
 * author can legally write. Used by the ConfigPanel autocomplete dropdown
 * (suggest a ref as the user types) AND by the lint pass that flags
 * unknown refs in any templated field of the current workflow.
 *
 * Pure / shared: no DOM, no node APIs. The same logic that powers the
 * autocomplete UI also powers server-side lint at save time.
 */

import type {
  ScriptConfig,
  SubworkflowConfig,
  Workflow,
  WorkflowNode,
} from './workflow';

export interface TemplateRef {
  /** Full `nodeId.path` string the user would write inside `{{ }}`. */
  ref: string;
  /** Source node id (e.g. `claude-1`), or `globals` for workflow-level
   * custom variables. */
  nodeId: string;
  /** Field path under the node (e.g. `stdout`, `output1`, `winner_index`)
   * or, for globals, the global variable name. */
  field: string;
  /** Human-readable hint shown next to the ref in the picker. */
  description: string;
  /** True when this ref is reachable from `selfId` via the workflow's
   * forward edge chain (or is a workflow-level global / __inputs). The
   * picker shows out-of-scope refs greyed out; lint flags them. */
  inScope: boolean;
  /** Kind of source: a node output, a workflow-level global, or the
   * subworkflow __inputs virtual scope. */
  kind: 'node' | 'global' | 'inputs';
}

/** Same shape as the runtime regex in lib/server/templating.ts. Anchored
 * so we can match across a whole templated string. */
export const TEMPLATE_REF_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Static output schema per node type. Container nodes are listed even
 * though their executor returns no scope, because we still want to filter
 * them OUT of the picker uniformly. */
function staticOutputs(type: WorkflowNode['type']): Array<{ field: string; description: string }> {
  switch (type) {
    case 'agent':
      return [
        { field: 'stdout', description: 'agent stdout (accumulated text)' },
        { field: 'stderr', description: 'agent stderr' },
        { field: 'exitCode', description: 'exit code (0 = success)' },
        { field: 'durationMs', description: 'elapsed time in ms' },
        { field: 'timedOut', description: 'true if the agent hit its timeout' },
      ];
    case 'script':
      return [
        { field: 'stdout', description: 'captured stdout' },
        { field: 'stderr', description: 'captured stderr' },
        { field: 'exitCode', description: 'exit code (0 = success)' },
        { field: 'durationMs', description: 'elapsed time in ms' },
        { field: 'timedOut', description: 'true if the script hit its timeout' },
        { field: 'language', description: 'script language: ts or py' },
      ];
    case 'condition':
      return [
        { field: 'met', description: 'true / false outcome of the predicate' },
        { field: 'detail', description: 'human-readable reason' },
      ];
    case 'branch':
      return [
        { field: 'result', description: 'true / false outcome' },
        { field: 'lhs', description: 'resolved left-hand side' },
        { field: 'rhs', description: 'resolved right-hand side' },
        { field: 'op', description: 'comparison operator' },
      ];
    case 'loop':
      return [
        { field: 'iterations', description: 'iteration count completed' },
        { field: 'broke', description: 'true if the loop ended via break' },
      ];
    case 'parallel':
      return [
        { field: 'mode', description: 'wait-all / race / quorum' },
        { field: 'completed', description: 'number of branches finished' },
        { field: 'failed', description: 'number of branches that failed' },
        { field: 'children', description: 'per-branch status / outputs map' },
        { field: 'winner', description: 'race mode: winning branch id' },
        { field: 'winners', description: 'quorum mode: winning branch ids' },
      ];
    case 'judge':
      return [
        { field: 'winner_index', description: 'index of the picked candidate' },
        { field: 'winner', description: 'text of the winning candidate' },
        { field: 'scores', description: 'per-candidate score map' },
        { field: 'reasoning', description: "judge's reasoning text" },
      ];
    case 'subworkflow':
      return [
        { field: 'status', description: 'succeeded / failed / cancelled' },
        { field: 'errorMessage', description: "set when status !== 'succeeded'" },
      ];
    case 'start':
    case 'end':
    case 'sidenote':
      return [];
  }
}

/** Dynamic outputs that depend on per-node config — script declares its
 * own output names, subworkflow declares parent-name outputs. */
function dynamicOutputs(node: WorkflowNode): Array<{ field: string; description: string }> {
  if (node.type === 'script') {
    const cfg = node.config as ScriptConfig | undefined;
    const names = Array.isArray(cfg?.outputs) ? cfg!.outputs : [];
    return names
      .filter((n) => typeof n === 'string' && n.length > 0)
      .map((n) => ({ field: n, description: 'declared script output' }));
  }
  if (node.type === 'subworkflow') {
    const cfg = node.config as SubworkflowConfig | undefined;
    const out = cfg?.outputs;
    if (!out || typeof out !== 'object') return [];
    return Object.keys(out).map((n) => ({
      field: n,
      description: 'subworkflow output mapping',
    }));
  }
  return [];
}

function walkAllNodes(
  nodes: readonly WorkflowNode[] | undefined,
  fn: (n: WorkflowNode) => void,
): void {
  if (!nodes) return;
  for (const n of nodes) {
    fn(n);
    if (n.children && n.children.length > 0) {
      walkAllNodes(n.children, fn);
    }
  }
}

/** Map each node id to its parent container id, if any. Only Loop and
 * Parallel act as containers today, but we trust `children` so any future
 * container automatically lights up here. */
function buildParentMap(workflow: Workflow): Map<string, string> {
  const parent = new Map<string, string>();
  const walk = (nodes: readonly WorkflowNode[], parentId?: string) => {
    for (const n of nodes) {
      if (parentId) parent.set(n.id, parentId);
      if (n.children && n.children.length > 0) walk(n.children, n.id);
    }
  };
  walk(workflow.nodes);
  return parent;
}

/**
 * Set of node ids whose outputs are guaranteed to exist on this run's
 * scope by the time `selfId` executes. Computed by walking the workflow's
 * edges in reverse from `selfId`. Container semantics:
 *
 *  - A node inside a Loop / Parallel container can also see its container's
 *    predecessors (whatever fed into the container counts as a predecessor
 *    for every child).
 *  - The container itself is a predecessor for any sibling that follows
 *    it at the top level (covered by normal reverse-BFS).
 *
 * The function is conservative: ambiguity counts as "not in scope". The
 * runtime will still resolve any ref that happens to land on scope, so
 * being conservative here only means the lint pass emits a warning the
 * user can dismiss. False negatives are the safer side of the trade.
 */
export function reachablePredecessors(
  workflow: Workflow,
  selfId: string,
): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of workflow.edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  const parent = buildParentMap(workflow);

  // Collect ancestor container ids — these are transit hops, never
  // surfaced as predecessors themselves (their outputs only settle after
  // the body, which is too late for any in-body reference).
  const containerAncestors = new Set<string>();
  for (let cur = parent.get(selfId); cur; cur = parent.get(cur)) {
    containerAncestors.add(cur);
  }

  // Reverse-BFS over edges, treating each ancestor container as an
  // additional "current" node so we pick up its predecessors too.
  const out = new Set<string>();
  const stack: string[] = [selfId, ...containerAncestors];
  const visited = new Set<string>(stack);
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const preds = incoming.get(cur);
    if (!preds) continue;
    for (const p of preds) {
      if (p === selfId) continue;
      if (containerAncestors.has(p)) {
        // Crossing back into our own ancestry doesn't add anything new.
        if (!visited.has(p)) {
          visited.add(p);
          stack.push(p);
        }
        continue;
      }
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
        visited.add(p);
      }
    }
  }
  return out;
}

/**
 * Every `{{nodeId.field}}` the user could write from inside `selfId`'s
 * config. Each ref carries an `inScope` flag: true when the source node
 * is reachable as a predecessor (or is a global / __inputs / the sentinel
 * `__none__` mode for the lint pass that wants the whole catalogue).
 *
 * Self-references are excluded entirely.
 *
 * Order: workflow-level globals first (so they're immediately visible in
 * the picker), then in-scope node refs in traversal order, then
 * out-of-scope ones. The picker greys the out-of-scope rows; the user
 * can still click them, and lint will flag the resulting workflow.
 */
export function availableVariables(
  workflow: Workflow | null,
  selfId: string,
): TemplateRef[] {
  if (!workflow) return [];
  // The lint pass passes `selfId='__none__'` to ask "what's the full
  // catalogue?" In that case every node ref is treated as in-scope so
  // `isKnownRef` works as a pure membership check.
  const showEverything = selfId === '__none__';
  const predecessors = showEverything
    ? null
    : reachablePredecessors(workflow, selfId);

  const inScope: TemplateRef[] = [];
  const outOfScope: TemplateRef[] = [];

  // Workflow-level globals — always in scope.
  const globals = workflow.globals ?? {};
  for (const name of Object.keys(globals)) {
    inScope.push({
      ref: `globals.${name}`,
      nodeId: 'globals',
      field: name,
      description: 'workflow global',
      inScope: true,
      kind: 'global',
    });
  }

  // Workflow-level inputs — always in scope. Mirror the globals
  // emission so the picker shows them at the top of the list.
  const inputs = workflow.inputs ?? [];
  for (const inp of inputs) {
    inScope.push({
      ref: `inputs.${inp.name}`,
      nodeId: 'inputs',
      field: inp.name,
      description: inp.description ?? `workflow input (${inp.type})`,
      inScope: true,
      kind: 'global',
    });
  }

  walkAllNodes(workflow.nodes, (n) => {
    if (n.id === selfId) return;
    const isPred = showEverything || predecessors!.has(n.id);
    const fields = [...staticOutputs(n.type), ...dynamicOutputs(n)];
    for (const f of fields) {
      const refObj: TemplateRef = {
        ref: `${n.id}.${f.field}`,
        nodeId: n.id,
        field: f.field,
        description: f.description,
        inScope: isPred,
        kind: 'node',
      };
      if (isPred) inScope.push(refObj);
      else outOfScope.push(refObj);
    }
  });

  return [...inScope, ...outOfScope];
}

/** Quick membership check used by the lint pass to decide whether a ref
 * exists at all (independent of scope). */
export function isKnownRef(workflow: Workflow | null, ref: string): boolean {
  if (!workflow) return false;
  const refs = availableVariables(workflow, '__none__');
  return refs.some((r) => r.ref === ref);
}

/** Which top-level config fields of each node type are templated strings —
 * mirrors lib/server/workflow-engine.ts TEXT_CONFIG_FIELDS. Kept here as a
 * separate constant so the lint pass can be run client-side without
 * dragging in the engine. Compound fields (script.inputs / subworkflow.inputs
 * / judge.candidates) are handled out-of-band below. */
const TEMPLATED_FIELDS: Partial<Record<WorkflowNode['type'], string[]>> = {
  agent: ['prompt', 'cwd'],
  condition: ['against'],
  branch: ['lhs', 'rhs'],
  script: ['cwd'],
  judge: ['criteria', 'judgePrompt'],
};

export interface TemplateLintWarning {
  nodeId: string;
  /** Dotted path of the field — `prompt`, `inputs.arg1`, `candidates.0`, … */
  field: string;
  /** The raw ref text the user wrote, e.g. `claude-1.stdout`. */
  ref: string;
  /**
   *  - 'unknown': no such node anywhere in the workflow
   *  - 'missing-field': node exists but doesn't expose this field
   *  - 'self-ref': the node references itself (always empty at runtime)
   *  - 'out-of-scope': node exists and has the field, but isn't reachable
   *    as a predecessor of selfId — at runtime its output won't be set
   *    yet (or never, if the two nodes are in different branches).
   *  - 'missing-global': `{{globals.X}}` where X isn't declared on the
   *    workflow.
   */
  reason:
    | 'unknown'
    | 'missing-field'
    | 'self-ref'
    | 'out-of-scope'
    | 'missing-global'
    | 'missing-input';
}

function classifyRef(
  workflow: Workflow,
  selfId: string,
  ref: string,
): TemplateLintWarning['reason'] | null {
  const parts = ref.split('.');
  const head = parts[0];

  if (head === selfId) return 'self-ref';

  // `__inputs.*` is a virtual scope inside subworkflow child runs; legal
  // at runtime so we never warn.
  if (head === '__inputs') return null;

  // Workflow-level globals.
  if (head === 'globals') {
    const name = parts.slice(1).join('.');
    const globals = workflow.globals ?? {};
    if (!name || !(name in globals)) return 'missing-global';
    return null;
  }

  // Workflow-level inputs.
  if (head === 'inputs') {
    const name = parts.slice(1).join('.');
    const inputs = workflow.inputs ?? [];
    if (!name || !inputs.some((i) => i.name === name)) return 'missing-input';
    return null;
  }

  const all = availableVariables(workflow, '__none__');
  const nodeMatches = all.some((r) => r.nodeId === head);
  if (!nodeMatches) return 'unknown';
  const fullMatch = all.some((r) => r.ref === ref);
  if (!fullMatch) return 'missing-field';

  // Field exists; check predecessor reachability.
  const preds = reachablePredecessors(workflow, selfId);
  if (!preds.has(head)) return 'out-of-scope';

  return null;
}

/** Scan a single string for `{{...}}` refs and classify each against the
 * workflow's known refs. Exported so the autocomplete UI can show
 * inline warnings per field without re-implementing the parse. */
export function lintField(
  workflow: Workflow,
  selfId: string,
  fieldPath: string,
  raw: string,
): TemplateLintWarning[] {
  if (!raw) return [];
  const out: TemplateLintWarning[] = [];
  // RegExp.exec with /g keeps lastIndex — reset per call so we don't
  // accidentally start mid-string from a previous invocation.
  const re = new RegExp(TEMPLATE_REF_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const ref = m[1];
    const reason = classifyRef(workflow, selfId, ref);
    if (reason !== null) {
      out.push({ nodeId: selfId, field: fieldPath, ref, reason });
    }
  }
  return out;
}

/** Walk every templated field of every node in the workflow and report
 * each unknown / self / missing-field ref. Useful for a pre-run validation
 * pass (or a workflow-menu "lint" button). */
export function lintWorkflowTemplates(
  workflow: Workflow,
): TemplateLintWarning[] {
  const out: TemplateLintWarning[] = [];

  const visit = (n: WorkflowNode) => {
    const cfg = n.config as Record<string, unknown> | undefined;
    if (cfg && typeof cfg === 'object') {
      const fields = TEMPLATED_FIELDS[n.type] ?? [];
      for (const f of fields) {
        const raw = cfg[f];
        if (typeof raw === 'string') {
          out.push(...lintField(workflow, n.id, f, raw));
        }
      }
      // script.inputs — Record<string, string>
      if (n.type === 'script' && cfg.inputs && typeof cfg.inputs === 'object') {
        for (const [name, value] of Object.entries(cfg.inputs as Record<string, unknown>)) {
          if (typeof value === 'string') {
            out.push(...lintField(workflow, n.id, `inputs.${name}`, value));
          }
        }
      }
      // subworkflow.inputs — Record<string, string>
      if (n.type === 'subworkflow' && cfg.inputs && typeof cfg.inputs === 'object') {
        for (const [name, value] of Object.entries(cfg.inputs as Record<string, unknown>)) {
          if (typeof value === 'string') {
            out.push(...lintField(workflow, n.id, `inputs.${name}`, value));
          }
        }
      }
      // judge.candidates — string[]
      if (n.type === 'judge' && Array.isArray(cfg.candidates)) {
        cfg.candidates.forEach((c, i) => {
          if (typeof c === 'string') {
            out.push(...lintField(workflow, n.id, `candidates.${i}`, c));
          }
        });
      }
    }
    if (n.children && n.children.length > 0) {
      for (const c of n.children) visit(c);
    }
  };

  for (const n of workflow.nodes) visit(n);
  return out;
}
