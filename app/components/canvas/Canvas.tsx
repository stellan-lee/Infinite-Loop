'use client';

import {
  Background,
  ConnectionLineType,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type ColorMode,
  type Connection,
  type Edge as XyEdge,
  type EdgeChange,
  type Node as XyNode,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useWorkflowStore } from '../../../lib/client/workflow-store-client';
import type {
  AgentConfig,
  BranchConfig,
  ConditionConfig,
  EdgeHandle,
  EndConfig,
  LoopConfig,
  ManualConfig,
  NodeConfigByType,
  NodeType,
  ParallelConfig,
  ScriptConfig,
  SidenoteConfig,
  StartConfig,
  StructuredOutputConfig,
  SubworkflowConfig,
  RunStatus,
  Workflow,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
} from '../../../lib/shared/workflow';
import {
  LOOP_DEFAULT_H,
  LOOP_DEFAULT_W,
  findContainingLoop,
  loopSizeFromChildren,
  pushOutsideLoops,
  pushSiblingsAfterLoopChange,
} from '../../../lib/shared/workflow-layout';
import { nextWorkflowNodeId } from '../../../lib/shared/workflow-graph';
import AgentNode from './nodes/AgentNode';
import BranchNode from './nodes/BranchNode';
import ConditionNode from './nodes/ConditionNode';
import EndNode from './nodes/EndNode';
import LoopNode from './nodes/LoopNode';
import ManualNode from './nodes/ManualNode';
import SendWebhookNode from './nodes/SendWebhookNode';
import GitHubCINode from './nodes/GitHubCINode';
import ParallelNode from './nodes/ParallelNode';
import ScriptNode from './nodes/ScriptNode';
import SidenoteNode from './nodes/SidenoteNode';
import StartNode from './nodes/StartNode';
import SubworkflowNode from './nodes/SubworkflowNode';
import StructuredOutputNode from './nodes/StructuredOutputNode';
import CanvasContextMenu, {
  type ContextMenuItem,
  type ContextMenuOpenAt,
} from './CanvasContextMenu';

/* ─── pure helpers (exported for tests) ─────────────────────────────────── */

export type NodeRunState = 'idle' | 'pending' | 'live' | 'succeeded' | 'failed';

export interface DropPayload {
  type: NodeType;
  label?: string;
  /** Required when `type === 'agent'`; selects the provider for the new node. */
  providerId?: string;
}

const DROP_MIME = 'application/x-infinite-loop-node';
const ADD_NODE_EVENT = 'infinite-loop:add-node';

/** Random hex id chunk (no nanoid dep). */
function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Default config factories per node type. */
const DEFAULT_CONFIG: { [K in NodeType]: () => NodeConfigByType[K] } = {
  start: (): StartConfig => ({}),
  end: (): EndConfig => ({}),
  agent: (): AgentConfig => ({
    providerId: 'claude',
    prompt: '',
    cwd: '',
    // 30 minutes. Agent runs (claude --print, hermes calls, etc.) routinely
    // take longer than a few seconds; 1 min was a paper cut for any real
    // task. The user can still narrow it per-node in the inspector.
    timeoutMs: 30 * 60 * 1000,
  }),
  condition: (): ConditionConfig => ({
    kind: 'sentinel',
    sentinel: { pattern: '', isRegex: false },
  }),
  loop: (): LoopConfig => ({ maxIterations: 5, mode: 'while-not-met' }),
  branch: (): BranchConfig => ({ lhs: '', op: '==', rhs: '' }),
  parallel: (): ParallelConfig => ({ mode: 'wait-all', onError: 'fail-fast' }),
  subworkflow: (): SubworkflowConfig => ({
    workflowId: '',
    inputs: {},
    outputs: {},
  }),
  'structured-output': (): StructuredOutputConfig => ({
    providerId: '',
    prompt: '',
    schema: {},
    timeoutMs: 30 * 60 * 1000,
  }),
  sidenote: (): SidenoteConfig => ({ text: '' }),
  script: (): ScriptConfig => ({
    language: 'ts',
    // The default seeds two named inputs and one named output, so the user
    // sees the function-shaped contract straight away without consulting
    // docs. Args arrive in declaration order; the returned object's keys
    // are matched against `outputs[]` and stored on this node's scope.
    inputs: { arg1: '', arg2: '' },
    outputs: ['output1'],
    code:
      'function run(arg1, arg2) {\n' +
      '  return { output1: `echo: ${arg1} + ${arg2}` };\n' +
      '}\n',
    timeoutMs: 60_000,
  }),
  'send-webhook': () => ({ url: 'https://example.com/webhook', method: 'POST', body: '{}', timeoutMs: 10_000, maxAttempts: 1 }),
  'github-ci': () => ({ repository: '{{inputs.repository}}', pullRequest: '{{inputs.pullRequest}}', required: [{ kind: 'check', name: 'test' }], timeoutMs: 3_600_000 }),
  manual: (): ManualConfig => ({
    // No brief by default — most authors will template upstream outputs into
    // it. The three conventional decisions are filled in by the executor
    // when `decisions` is omitted (see lib/server/nodes/manual.ts), so the
    // node is usable straight from the palette.
    brief: '',
    decisions: [
      { key: 'accepted' },
      { key: 'needs_changes' },
      { key: 'rejected' },
    ],
  }),
};

/** Default config object for a fresh node of a given type. */
export function defaultConfigFor<T extends NodeType>(type: T): NodeConfigByType[T] {
  return DEFAULT_CONFIG[type]();
}

/** Compute the next available numeric suffix id for a given node type. */
export function nextNodeId(type: NodeType, existing: WorkflowNode[]): string {
  return nextWorkflowNodeId(type, existing);
}

/** Build a fresh node from a drop payload + position + existing nodes. */
export function buildDroppedNode(
  payload: DropPayload,
  position: { x: number; y: number },
  existing: WorkflowNode[],
): WorkflowNode {
  const id = nextNodeId(payload.type, existing);
  const config = defaultConfigFor(payload.type) as Record<string, unknown>;
  if (payload.type === 'agent' && payload.providerId) {
    (config as unknown as AgentConfig).providerId = payload.providerId;
  }
  return {
    id,
    type: payload.type,
    position,
    config: config as WorkflowNode['config'],
    label: payload.label,
  };
}

/** Loose connection input — xyflow may emit partial values during drag. */
export interface EdgeInput {
  source: string | null | undefined;
  target: string | null | undefined;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** Build a WorkflowEdge from an xyflow connection. */
export function buildEdge(conn: EdgeInput): WorkflowEdge | null {
  if (!conn.source || !conn.target) return null;
  return {
    id: `e_${rid()}`,
    source: conn.source,
    sourceHandle: (conn.sourceHandle as EdgeHandle) || 'next',
    target: conn.target,
    ...(conn.targetHandle ? { targetHandle: conn.targetHandle } : {}),
  };
}

/** Walk events in order; last status per node wins. node_started → live; node_finished → succeeded/failed. */
export function buildLiveStateMap(
  events: readonly WorkflowEvent[],
): Record<string, NodeRunState> {
  const out: Record<string, NodeRunState> = {};
  for (const ev of events) {
    if (ev.type === 'node_started') {
      out[ev.nodeId] = 'live';
    } else if (ev.type === 'node_finished') {
      out[ev.nodeId] = (ev.branch === 'error' || ev.branch === 'failure') ? 'failed' : 'succeeded';
    }
  }
  return out;
}

export { findContainingLoop, pushOutsideLoops, pushSiblingsAfterLoopChange };

/** Build an xyflow node from a workflow node, optionally as a child. */
function buildXyNode(
  n: WorkflowNode,
  liveMap: Record<string, NodeRunState>,
  selectedNodeId: string | null,
  runStatus: RunStatus = 'idle',
  parentId?: string,
): XyNode {
  const state: NodeRunState = liveMap[n.id] ?? (runStatus === 'running' ? 'pending' : 'idle');
  const base: XyNode = {
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 0, y: 0 },
    selected: n.id === selectedNodeId,
    data: {
      // Pass the user-set label through as undefined when absent so each
      // node component can decide its own type-specific fallback (e.g.
      // "START", or for AgentNode the brand icon). Previously defaulted
      // to `n.id` which made it impossible to tell "no custom name" from
      // "name happens to equal the id".
      label: n.label,
      config: n.config ?? {},
      _state: state,
    },
  };
  if (parentId) {
    base.parentId = parentId;
    base.extent = 'parent';
  }
  // Persisted size wins. Otherwise, for a Loop, fit the container to its
  // children's bounding box so legacy workflows (saved without a `size`)
  // don't get xyflow's `extent: 'parent'` clamping their kids on top of
  // each other inside the default 460px-wide box.
  if (n.size) {
    base.style = { width: n.size.width, height: n.size.height };
  } else if (n.type === 'loop') {
    const { width, height } = loopSizeFromChildren(n.children);
    base.style = { width, height };
  }
  return base;
}

/** Map a Workflow + live state into xyflow nodes/edges. Recurses into
 * container `children` (Loop) and emits each child as a flat xyflow node
 * with `parentId` set so xyflow renders it inside the container. */
export function workflowToXyflow(
  workflow: Workflow | null,
  liveMap: Record<string, NodeRunState>,
  selectedNodeId: string | null,
  selectedEdgeId: string | null = null,
  runStatus: RunStatus = 'idle',
): { nodes: XyNode[]; edges: XyEdge[] } {
  if (!workflow) return { nodes: [], edges: [] };
  const wfNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const wfEdges = Array.isArray(workflow.edges) ? workflow.edges : [];

  // Containers (Loop) emit no `node_started` events of their own, so derive
  // their state from their children. While a run is active, unvisited children
  // are pending, making the container read as not-yet-run instead of idle.
  const effectiveLive: Record<string, NodeRunState> = { ...liveMap };
  for (const n of wfNodes) {
    if (n.type === 'loop' && Array.isArray(n.children) && n.children.length) {
      const childStates = n.children.map(
        (c) => liveMap[c.id] ?? (runStatus === 'running' ? 'pending' : 'idle'),
      );
      if (childStates.includes('live')) effectiveLive[n.id] = 'live';
      else if (childStates.includes('failed')) effectiveLive[n.id] = 'failed';
      else if (runStatus === 'running' && childStates.includes('pending')) {
        effectiveLive[n.id] = 'pending';
      } else if (
        childStates.length > 0 &&
        childStates.every((state) => state === 'succeeded')
      ) {
        effectiveLive[n.id] = 'succeeded';
      }
    }
  }

  const nodes: XyNode[] = [];
  for (const n of wfNodes) {
    nodes.push(buildXyNode(n, effectiveLive, selectedNodeId, runStatus));
    if (Array.isArray(n.children)) {
      for (const child of n.children) {
        nodes.push(buildXyNode(child, effectiveLive, selectedNodeId, runStatus, n.id));
      }
    }
  }

  const edges: XyEdge[] = wfEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    // Round-trip selection so xyflow's Backspace-to-delete keystroke can
    // act on the edge the user clicked.
    selected: e.id === selectedEdgeId,
    type: 'default',
  }));
  return { nodes, edges };
}

/* ─── component ──────────────────────────────────────────────────────────── */

const NODE_TYPES = {
  start: StartNode,
  end: EndNode,
  agent: AgentNode,
  condition: ConditionNode,
  loop: LoopNode,
  branch: BranchNode,
  parallel: ParallelNode,
  subworkflow: SubworkflowNode,
  'structured-output': StructuredOutputNode,
  sidenote: SidenoteNode,
  script: ScriptNode,
  manual: ManualNode,
  'github-ci': GitHubCINode,
  'send-webhook': SendWebhookNode,
} as const;

function CanvasInner() {
  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const runEvents = useWorkflowStore((s) => s.runEvents);
  const inspectedRunEvents = useWorkflowStore((s) => s.inspectedRunEvents);
  const updateNode = useWorkflowStore((s) => s.updateNode);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const removeEdge = useWorkflowStore((s) => s.removeEdge);
  const addEdge = useWorkflowStore((s) => s.addEdge);
  const addNode = useWorkflowStore((s) => s.addNode);
  const addChildNode = useWorkflowStore((s) => s.addChildNode);
  const selectNode = useWorkflowStore((s) => s.selectNode);

  // Edge selection is local-only (not persisted): we just need it long
  // enough for xyflow to know which edge Backspace targets.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const { screenToFlowPosition, fitView, getNode } = useReactFlow();

  // Sync xyflow's color mode with the app theme (set on
  // `document.documentElement.dataset.theme` by the pre-paint script in
  // `app/layout.tsx`, kept in sync by `ThemeToggle`).
  //
  // The editor is light-first, matching the application's pre-paint default.
  // A mutation observer keeps ReactFlow's own colour-mode class in sync when
  // the user switches to the optional dark theme.
  const [docTheme, setDocTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const html = document.documentElement;
    const read = (): 'light' | 'dark' =>
      html.dataset.theme === 'light' ? 'light' : 'dark';
    setDocTheme(read());
    // ThemeToggle mutates `data-theme` on <html>; observe so the canvas
    // re-renders into the new color mode without a full reload.
    const obs = new MutationObserver(() => setDocTheme(read()));
    obs.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  const colorMode: ColorMode = docTheme;

  // Fit the viewport to the workflow once per loaded workflow. Without this
  // an opened workflow whose nodes sit at large x/y may render partially
  // behind the palette or off the right edge.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = currentWorkflow?.id ?? null;
    const hasNodes = (currentWorkflow?.nodes?.length ?? 0) > 0;
    if (!id || !hasNodes || fittedFor.current === id) return;
    fittedFor.current = id;
    // Defer to the next frame so xyflow has measured the freshly-mounted nodes.
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.14, maxZoom: 1.05, minZoom: 0.6, duration: 200 });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentWorkflow?.id, currentWorkflow?.nodes?.length, fitView]);

  // Pan-to-node requests from outside the canvas (e.g. clicking a node card
  // in the recorded run history). The `seq` field on `panRequest` advances on
  // every call so the effect re-fires for repeat clicks on the same node.
  // Guard against a node id that isn't in the currently-loaded workflow
  // (recorded runs can reference renamed/deleted nodes) — fitView would
  // silently no-op, leaving the user wondering why the canvas didn't move.
  const panRequest = useWorkflowStore((s) => s.panRequest);
  useEffect(() => {
    if (!panRequest) return;
    if (!getNode(panRequest.nodeId)) return;
    fitView({
      nodes: [{ id: panRequest.nodeId }],
      padding: 0.3,
      maxZoom: 1.2,
      duration: 250,
    });
  }, [panRequest, fitView, getNode]);

  // Memoize the nodeTypes map so xyflow doesn't warn / re-create internals.
  const nodeTypes = useMemo(() => NODE_TYPES, []);

  // History supplies a separate terminal event stream. Prefer it while a
  // record is open so the canvas shows that run's exact successful and failed
  // path, without rewriting the live run's status or event log.
  const displayedRunEvents = inspectedRunEvents ?? runEvents;
  const liveMap = useMemo(
    () => buildLiveStateMap(displayedRunEvents),
    [displayedRunEvents],
  );
  // Treat nodes absent from a selected history record as pending so they use
  // the neutral gray treatment. This makes the executed path immediately
  // legible: green = completed, red = error branch, gray = not reached.
  const displayedRunStatus: RunStatus = inspectedRunEvents ? 'running' : runStatus;

  const { nodes, edges } = useMemo(
    () => workflowToXyflow(
      currentWorkflow,
      liveMap,
      selectedNodeId,
      selectedEdgeId,
      displayedRunStatus,
    ),
    [currentWorkflow, liveMap, selectedNodeId, selectedEdgeId, displayedRunStatus],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const wf = currentWorkflow;
      const topLevel = wf?.nodes ?? [];
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) {
          // Persist EVERY position change, including intermediate ones during
          // a drag — xyflow renders nodes from the controlled `nodes` prop, so
          // dropping mid-drag updates makes the card visually freeze and snap
          // to the release point.
          //
          // For top-level non-Loop nodes, snap the proposed position out of
          // any Loop's bbox. For Loops themselves, after persisting the new
          // position, push any siblings that the Loop just engulfed back out.
          // Children (parentId set) are already constrained by xyflow's
          // `extent: 'parent'`.
          const target = topLevel.find((n) => n.id === ch.id);
          if (!target) {
            updateNode(ch.id, { position: ch.position });
            continue;
          }
          if (target.type === 'loop') {
            updateNode(ch.id, { position: ch.position });
            const updates = pushSiblingsAfterLoopChange(
              {
                id: target.id,
                x: ch.position.x,
                y: ch.position.y,
                width: target.size?.width ?? LOOP_DEFAULT_W,
                height: target.size?.height ?? LOOP_DEFAULT_H,
              },
              topLevel,
            );
            for (const u of updates) updateNode(u.id, { position: u.position });
            continue;
          }
          const nextPos = pushOutsideLoops(
            { id: ch.id, position: ch.position, size: target.size },
            topLevel,
          );
          updateNode(ch.id, { position: nextPos });
        } else if (ch.type === 'dimensions' && ch.resizing && ch.dimensions) {
          // Only persist when the user is actively resizing (NodeResizer
          // sets `resizing: true`). xyflow also emits dimensions changes on
          // first measure of every node — those have `resizing` undefined
          // and we ignore them so we don't pollute the store with values
          // that aren't really the user's intent.
          updateNode(ch.id, {
            size: { width: ch.dimensions.width, height: ch.dimensions.height },
          });
          // If a Loop just grew, push any sibling it engulfed back out of
          // its NEW bbox (the just-resized one).
          const target = topLevel.find((n) => n.id === ch.id);
          if (target?.type === 'loop') {
            const updates = pushSiblingsAfterLoopChange(
              {
                id: target.id,
                x: target.position.x,
                y: target.position.y,
                width: ch.dimensions.width,
                height: ch.dimensions.height,
              },
              topLevel,
            );
            for (const u of updates) updateNode(u.id, { position: u.position });
          }
        } else if (ch.type === 'select') {
          selectNode(ch.selected ? ch.id : null);
        } else if (ch.type === 'remove') {
          removeNode(ch.id);
        }
      }
    },
    [updateNode, selectNode, removeNode, currentWorkflow],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const ch of changes) {
        if (ch.type === 'remove') {
          removeEdge(ch.id);
          // If the removed edge was the selected one, clear the local marker
          // so xyflow's next render doesn't try to re-mark a missing edge.
          setSelectedEdgeId((prev) => (prev === ch.id ? null : prev));
        } else if (ch.type === 'select') {
          // Round-trip selection through local state so the controlled
          // `edges` prop carries `selected: true` on the right edge — without
          // this xyflow's Backspace key has no selected edge to remove.
          setSelectedEdgeId((prev) =>
            ch.selected ? ch.id : prev === ch.id ? null : prev,
          );
        }
      }
    },
    [removeEdge],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const edge = buildEdge(conn);
      if (edge) addEdge(edge);
    },
    [addEdge],
  );

  /**
   * Place a node described by `payload` at flow-graph position `rawPosition`.
   * Shared by drag-drop and the right-click menu so the Loop-adoption +
   * push-out-of-loop rules behave identically.
   */
  const placeNodeFromPayload = useCallback(
    (payload: DropPayload, rawPosition: { x: number; y: number }) => {
      const wf = currentWorkflow;
      if (!wf) return;
      // Loops themselves never become children of another Loop today.
      if (payload.type !== 'loop') {
        const containing = findContainingLoop(rawPosition, wf.nodes);
        if (containing) {
          // Position falls inside a Loop's bbox → adopt as a child. xyflow
          // renders child positions relative to the parent, so subtract the
          // Loop's origin.
          const local = {
            x: rawPosition.x - containing.position.x,
            y: rawPosition.y - containing.position.y,
          };
          const child = buildDroppedNode(
            payload,
            local,
            wf.nodes,
          );
          addChildNode(containing.id, child);
          return;
        }
      }
      // Outside any Loop (or Loop-on-Loop): top-level placement, with
      // overlap-prevention pushing the new card to the nearest outside edge.
      const position =
        payload.type === 'loop'
          ? rawPosition
          : pushOutsideLoops(
              { id: '', position: rawPosition },
              wf.nodes,
            );
      const node = buildDroppedNode(payload, position, wf.nodes);
      addNode(node);
    },
    [addNode, addChildNode, currentWorkflow],
  );

  useEffect(() => {
    const onAddNode = (event: Event) => {
      const payload = (event as CustomEvent<DropPayload>).detail;
      if (!payload?.type) return;
      const canvas = document.querySelector('.canvas-shell');
      const rect = canvas?.getBoundingClientRect();
      const point = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      placeNodeFromPayload(payload, screenToFlowPosition(point));
    };
    window.addEventListener(ADD_NODE_EVENT, onAddNode);
    return () => window.removeEventListener(ADD_NODE_EVENT, onAddNode);
  }, [placeNodeFromPayload, screenToFlowPosition]);

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Browsers default to "drop forbidden" unless dragenter AND dragover both
    // call preventDefault().
    if (e.dataTransfer.types.includes(DROP_MIME)) {
      e.preventDefault();
    }
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(DROP_MIME)) return;
    e.preventDefault();
    // Must match the palette's `effectAllowed = 'copy'`. If we say 'move' here
    // and the source said 'copy', the browser shows the no-drop cursor and
    // refuses the drop entirely.
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentWorkflow) {
        console.warn('[canvas] drop ignored: no current workflow');
        return;
      }
      const raw = e.dataTransfer.getData(DROP_MIME);
      if (!raw) {
        console.warn(
          '[canvas] drop ignored: no payload at MIME',
          DROP_MIME,
          'available types:',
          Array.from(e.dataTransfer.types),
        );
        return;
      }
      let payload: DropPayload;
      try {
        payload = JSON.parse(raw) as DropPayload;
      } catch (err) {
        console.warn('[canvas] drop payload not JSON:', err);
        return;
      }
      if (!payload?.type) {
        console.warn('[canvas] drop payload missing type', payload);
        return;
      }
      const rawPosition = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      placeNodeFromPayload(payload, rawPosition);
    },
    [placeNodeFromPayload, currentWorkflow, screenToFlowPosition],
  );

  /* ─── right-click context menu ────────────────────────────────────────── */

  const [menuOpen, setMenuOpen] = useState<ContextMenuOpenAt | null>(null);

  const onCanvasContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Open only when the right-click landed on empty canvas area. xyflow
      // renders nodes/edges/handles/controls as descendants of
      // `.react-flow__pane`, so a positive-match on the pane alone doesn't
      // distinguish empty space from a node. Negative-match every interactive
      // xyflow surface so a future node-aware menu can claim them.
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          '.react-flow__node,' +
            '.react-flow__edge,' +
            '.react-flow__handle,' +
            '.react-flow__controls',
        )
      ) {
        return;
      }
      e.preventDefault();
      if (!currentWorkflow) return;
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Toggle: a second right-click while the menu is already open closes
      // it instead of repositioning. Functional setState so we can read the
      // previous state without depending on `menuOpen` in the deps array
      // (which would invalidate the callback on every menu state change).
      setMenuOpen((prev) =>
        prev
          ? null
          : {
              clientX: e.clientX,
              clientY: e.clientY,
              flowX: flow.x,
              flowY: flow.y,
            },
      );
    },
    [currentWorkflow, screenToFlowPosition],
  );

  const onContextMenuPick = useCallback(
    (item: ContextMenuItem, at: ContextMenuOpenAt) => {
      const payload: DropPayload = { type: item.type };
      if (item.providerId) payload.providerId = item.providerId;
      placeNodeFromPayload(payload, { x: at.flowX, y: at.flowY });
    },
    [placeNodeFromPayload],
  );

  return (
    <div
      aria-label="canvas"
      className="canvas-shell"
      onDrop={onDrop}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onContextMenu={onCanvasContextMenu}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ padding: 0.14, maxZoom: 1.05, minZoom: 0.6 }}
        connectionLineType={ConnectionLineType.Bezier}
        defaultEdgeOptions={{ type: 'default', style: { strokeWidth: 2 } }}
        // Keep a drag focused on repositioning the card. React Flow otherwise
        // selects at drag start, which opens the inspector and shifts the
        // canvas under the pointer mid-gesture. A normal click still selects.
        selectNodesOnDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1.15} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!currentWorkflow && (
        <div className="canvas-empty" role="status">
          <h2>No workflow loaded</h2>
          <p>Select a workflow from the menu, then run it or edit the graph.</p>
        </div>
      )}
      <CanvasContextMenu
        open={menuOpen}
        onClose={() => setMenuOpen(null)}
        onPick={onContextMenuPick}
      />
    </div>
  );
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
