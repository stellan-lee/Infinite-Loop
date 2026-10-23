'use client';

import type { SendWebhookOutput } from '../shared/send-webhook';
import { create } from 'zustand';
import type { GitHubCIOutput } from '../shared/github-ci';
import type {
  RunStatus,
  Workflow,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowInputDecl,
  WorkflowNode,
  WsStatus,
} from '../shared/workflow';
import {
  collectNodeSubtreeIdsById,
  filterWorkflowNodeSubtree,
  mapWorkflowNodes,
  workflowContainsNode,
} from '../shared/workflow-graph';
import { normalizeWorkflowGeometry } from '../shared/workflow-layout';

/** Max snapshots kept in each history stack. Old entries are dropped. */
export const HISTORY_LIMIT = 50;
/** Snapshots arriving within this many ms of the previous push are treated
 * as a continuation of the same interaction (drag/resize/typing) and skipped
 * so one user gesture maps to one undo entry. */
export const HISTORY_COALESCE_MS = 250;

export interface WorkflowStoreState {
  currentWorkflow: Workflow | null;
  isDirty: boolean;
  selectedNodeId: string | null;
  runStatus: RunStatus;
  runEvents: WorkflowEvent[];
  githubCI: Record<string, GitHubCIOutput>;
  webhooks: Record<string, SendWebhookOutput>;
  /** Events from the recorded run currently open in History. These only
   * drive the canvas outcome overlay; they never replace the live run state. */
  inspectedRunEvents: WorkflowEvent[] | null;
  connectionStatus: WsStatus;
  /** Live overlay: maps triggerId → epoch-ms of most recent trigger_started event. */
  triggerLastFiredAt: Record<string, number>;

  /** Cross-component "pan canvas to this node" signal. `seq` advances on each
   * call so a repeat request for the same node id still fires the canvas
   * effect — without it React would dedupe equal state and the second click
   * would silently no-op. */
  panRequest: { nodeId: string; seq: number } | null;

  /** Past snapshots — the head is the most-recent prior `currentWorkflow`. */
  past: Workflow[];
  /** Future snapshots — populated on undo, cleared on any new mutation. */
  future: Workflow[];

  loadWorkflow: (w: Workflow) => void;
  setNodes: (nodes: WorkflowNode[]) => void;
  setEdges: (edges: WorkflowEdge[]) => void;
  addNode: (node: WorkflowNode) => void;
  /** Insert `child` into the `children` array of the top-level container
   * with id `parentId`. No-ops if the parent is missing or isn't a container. */
  addChildNode: (parentId: string, child: WorkflowNode) => void;
  updateNode: (id: string, patch: Partial<Omit<WorkflowNode, 'id'>>) => void;
  removeNode: (id: string) => void;
  addEdge: (edge: WorkflowEdge) => void;
  removeEdge: (id: string) => void;
  selectNode: (id: string | null) => void;
  /** Ask the canvas to pan-to-fit the given node. The canvas subscribes to
   * `panRequest` and calls `fitView` whenever the reference changes. */
  requestPanToNode: (id: string) => void;
  /** Replace the current workflow's `globals` map. Pass an empty object
   * to clear all globals. Tracked in undo history. */
  setGlobals: (next: Record<string, string>) => void;
  /** Set the workflow-wide working directory. Undefined uses the `/tmp`
   * execution fallback unless a node provides its own cwd. */
  setWorkflowCwd: (next: string | undefined) => void;
  /** Replace the current workflow's `inputs` array. Pass an empty
   * array to clear all declared inputs. Tracked in undo history. */
  setWorkflowInputs: (next: WorkflowInputDecl[]) => void;
  saveCurrentWorkflow: () => Promise<void>;
  /** Rename the current workflow and immediately persist via PUT. The full
   * workflow body is sent, so any pending edits are flushed alongside the
   * rename — this matches the "save immediately" semantics for inline rename
   * in the top menu. No-op when name is empty/unchanged. */
  renameCurrentWorkflow: (name: string) => Promise<void>;

  /** Restore the previous workflow snapshot. No-op if nothing to undo. */
  undo: () => void;
  /** Re-apply a snapshot popped from the future stack. No-op when empty. */
  redo: () => void;

  appendRunEvent: (ev: WorkflowEvent) => void;
  setRunStatus: (status: RunStatus) => void;
  resetRun: () => void;
  /** Replace the run state in one shot — used when the SSE state_snapshot
   * arrives and we want to rehydrate the log + status after a refresh. */
  hydrateRun: (input: { status: RunStatus; events: WorkflowEvent[]; githubCI?: Record<string, GitHubCIOutput>; webhooks?: Record<string, SendWebhookOutput> }) => void;
  setInspectedRunEvents: (events: WorkflowEvent[] | null) => void;
  setConnectionStatus: (s: WsStatus) => void;
}

export { normalizeWorkflowGeometry } from '../shared/workflow-layout';

const bumpUpdated = (w: Workflow): Workflow => ({ ...w, updatedAt: Date.now() });

/**
 * Compute the next history stacks given the workflow we're about to leave
 * behind. Returns a partial state slice; callers spread it into their `set`.
 *
 * Coalescing: if the previous push happened within HISTORY_COALESCE_MS, treat
 * the in-flight gesture (drag, resize, typing) as a continuation and skip the
 * push so one gesture = one undo entry.
 */
function pushPast(
  state: WorkflowStoreState,
  prevWf: Workflow,
): Pick<WorkflowStoreState, 'past' | 'future'> {
  const now = Date.now();
  const coalesced = now - lastHistoryPushAt < HISTORY_COALESCE_MS;
  // Sliding-window: advance the marker on EVERY mutation, including coalesced
  // ones, so a long gesture made of sub-coalesce-window ticks (60fps drag)
  // stays a single history entry instead of fragmenting once the gap from the
  // original push exceeds the window.
  lastHistoryPushAt = now;
  if (coalesced) {
    // Mid-gesture: keep the existing past head as the gesture's anchor, but
    // still wipe the future stack — any further mutation invalidates redo.
    return { past: state.past, future: [] };
  }
  const nextPast = [...state.past, prevWf];
  if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
  return { past: nextPast, future: [] };
}

/**
 * Module-level timestamp of the last accepted history push. Lives outside the
 * store so it isn't subscribed-to by React; it's purely a coalescing marker.
 */
let lastHistoryPushAt = 0;

export const useWorkflowStore = create<WorkflowStoreState>((set, get) => ({
  currentWorkflow: null,
  isDirty: false,
  selectedNodeId: null,
  runStatus: 'idle',
  runEvents: [],
  githubCI: {},
  webhooks: {},
  inspectedRunEvents: null,
  connectionStatus: 'connecting',
  triggerLastFiredAt: {},
  panRequest: null,
  past: [],
  future: [],

  loadWorkflow: (w) => {
    if (!w || !Array.isArray(w.nodes) || !Array.isArray(w.edges)) {
      console.warn('[workflow-store] loadWorkflow rejected malformed input', w);
      return;
    }
    // Loading a different workflow invalidates history — entries describe a
    // different document and shouldn't survive the swap.
    lastHistoryPushAt = 0;
    const normalized = normalizeWorkflowGeometry(w);
    // If normalize materially changed the geometry (e.g. an old workflow with
    // a missing Loop `size` got auto-fitted, or a sibling got pushed out),
    // surface the dirty marker so a save persists the corrected layout. Next
    // load is a no-op then — the bug stops re-occurring per workflow file.
    const wasMutated = normalized !== w;
    set({
      currentWorkflow: normalized,
      isDirty: wasMutated,
      selectedNodeId: null,
      past: [],
      future: [],
    });
  },

  setNodes: (nodes) =>
    set((s) => {
      if (!s.currentWorkflow) return {};
      return {
        currentWorkflow: bumpUpdated({ ...s.currentWorkflow, nodes }),
        isDirty: true,
        ...pushPast(s, s.currentWorkflow),
      };
    }),

  setEdges: (edges) =>
    set((s) => {
      if (!s.currentWorkflow) return {};
      return {
        currentWorkflow: bumpUpdated({ ...s.currentWorkflow, edges }),
        isDirty: true,
        ...pushPast(s, s.currentWorkflow),
      };
    }),

  addNode: (node) =>
    set((s) => {
      const wf = s.currentWorkflow;
      if (!wf) return {};
      return {
        currentWorkflow: bumpUpdated({ ...wf, nodes: [...wf.nodes, node] }),
        isDirty: true,
        ...pushPast(s, wf),
      };
    }),

  addChildNode: (parentId, child) =>
    set((s) => {
      const wf = s.currentWorkflow;
      if (!wf) return {};
      const nextNodes = wf.nodes.map((n) => {
        if (n.id !== parentId) return n;
        const existing = Array.isArray(n.children) ? n.children : [];
        return { ...n, children: [...existing, child] };
      });
      return {
        currentWorkflow: bumpUpdated({ ...wf, nodes: nextNodes }),
        isDirty: true,
        ...pushPast(s, wf),
      };
    }),

  updateNode: (id, patch) =>
    set((s) => {
      const wf = s.currentWorkflow;
      if (!wf) return {};
      return {
        currentWorkflow: bumpUpdated({
          ...wf,
          nodes: mapWorkflowNodes(wf.nodes, (n) =>
            n.id === id ? ({ ...n, ...patch } as WorkflowNode) : n,
          ),
        }),
        isDirty: true,
        ...pushPast(s, wf),
      };
    }),

  removeNode: (id) =>
    set((s) => {
      const wf = s.currentWorkflow;
      if (!wf) return {};
      const removedIds = collectNodeSubtreeIdsById(wf.nodes, id);
      return {
        currentWorkflow: bumpUpdated({
          ...wf,
          nodes: filterWorkflowNodeSubtree(wf.nodes, id),
          edges: wf.edges.filter(
            (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
          ),
        }),
        isDirty: true,
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        ...pushPast(s, wf),
      };
    }),

  addEdge: (edge) =>
    set((s) => {
      const wf = s.currentWorkflow;
      if (!wf) return {};
      return {
        currentWorkflow: bumpUpdated({ ...wf, edges: [...wf.edges, edge] }),
        isDirty: true,
        ...pushPast(s, wf),
      };
    }),

  removeEdge: (id) =>
    set((s) => {
      const wf = s.currentWorkflow;
      if (!wf) return {};
      return {
        currentWorkflow: bumpUpdated({
          ...wf,
          edges: wf.edges.filter((e) => e.id !== id),
        }),
        isDirty: true,
        ...pushPast(s, wf),
      };
    }),

  undo: () =>
    set((s) => {
      if (s.past.length === 0 || !s.currentWorkflow) return {};
      const prev = s.past[s.past.length - 1];
      const nextPast = s.past.slice(0, -1);
      // Reset coalesce marker so the next mutation lands as a fresh entry,
      // not a continuation of whatever happened before the undo.
      lastHistoryPushAt = 0;
      return {
        currentWorkflow: prev,
        past: nextPast,
        future: [...s.future, s.currentWorkflow],
        isDirty: true,
        // Drop selection if it points at a node that no longer exists in
        // the restored snapshot.
        selectedNodeId:
          s.selectedNodeId &&
          !workflowContainsNode(prev, s.selectedNodeId)
            ? null
            : s.selectedNodeId,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0 || !s.currentWorkflow) return {};
      const next = s.future[s.future.length - 1];
      const nextFuture = s.future.slice(0, -1);
      lastHistoryPushAt = 0;
      return {
        currentWorkflow: next,
        past: [...s.past, s.currentWorkflow],
        future: nextFuture,
        isDirty: true,
        selectedNodeId:
          s.selectedNodeId &&
          !workflowContainsNode(next, s.selectedNodeId)
            ? null
            : s.selectedNodeId,
      };
    }),

  selectNode: (id) => set({ selectedNodeId: id }),

  requestPanToNode: (id) =>
    set((s) => ({
      panRequest: { nodeId: id, seq: (s.panRequest?.seq ?? 0) + 1 },
    })),

  setGlobals: (next) =>
    set((s) => {
      if (!s.currentWorkflow) return {};
      return {
        currentWorkflow: bumpUpdated({ ...s.currentWorkflow, globals: next }),
        isDirty: true,
        ...pushPast(s, s.currentWorkflow),
      };
    }),

  setWorkflowCwd: (next) =>
    set((s) => {
      if (!s.currentWorkflow) return {};
      const cwd = next?.trim() || undefined;
      return {
        currentWorkflow: bumpUpdated({ ...s.currentWorkflow, cwd }),
        isDirty: true,
        ...pushPast(s, s.currentWorkflow),
      };
    }),

  setWorkflowInputs: (next) =>
    set((s) => {
      if (!s.currentWorkflow) return {};
      return {
        currentWorkflow: bumpUpdated({ ...s.currentWorkflow, inputs: next }),
        isDirty: true,
        ...pushPast(s, s.currentWorkflow),
      };
    }),

  saveCurrentWorkflow: async () => {
    const wf = get().currentWorkflow;
    if (!wf) return;
    const res = await fetch(`/api/workflows/${encodeURIComponent(wf.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wf),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    set({ isDirty: false });
  },

  renameCurrentWorkflow: async (name) => {
    const wf = get().currentWorkflow;
    if (!wf) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === wf.name) return;
    const next: Workflow = { ...wf, name: trimmed, updatedAt: Date.now() };
    // Optimistic update + dirty marker. If the PUT fails the dirty flag
    // stays on so the user sees "•" and can retry via Save.
    set((s) => ({
      currentWorkflow: next,
      isDirty: true,
      ...pushPast(s, wf),
    }));
    const res = await fetch(`/api/workflows/${encodeURIComponent(next.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!res.ok) throw new Error(`rename failed: ${res.status}`);
    set({ isDirty: false });
  },

  appendRunEvent: (ev) =>
    set((s) => {
      // `run_started` marks a fresh run boundary — drop the previous run's
      // events so the panel only shows the latest run. Without this the log
      // accumulates across runs and "the new run starts" gets lost in the
      // tail of the old one.
      const baseEvents = ev.type === 'run_started' ? [] : s.runEvents;
      const next: Partial<WorkflowStoreState> = {
        runEvents: [...baseEvents, ev],
      };
      if (ev.type === 'run_started') {
        next.runStatus = 'running';
        next.githubCI = {};
        next.webhooks = {};
      }
      if (ev.type === 'webhook_updated') next.webhooks = { ...s.webhooks, [ev.nodeId]: ev.output };
      if (ev.type === 'github_ci_updated') next.githubCI = { ...s.githubCI, [ev.nodeId]: ev.output };
      if (ev.type === 'run_finished') next.runStatus = ev.status;
      if (ev.type === 'trigger_started') {
        next.triggerLastFiredAt = {
          ...s.triggerLastFiredAt,
          [ev.triggerId]: Date.now(),
        };
      }
      return next as WorkflowStoreState;
    }),

  setRunStatus: (runStatus) => set({ runStatus }),

  resetRun: () => set({ runEvents: [], githubCI: {}, webhooks: {}, runStatus: 'idle' }),

  hydrateRun: ({ status, events, githubCI, webhooks }) =>
    set({
      runStatus: status,
      runEvents: [...events],
      webhooks: webhooks ?? Object.fromEntries(events.filter(event => event.type === 'webhook_updated').map(event => [event.nodeId, event.output])),
      githubCI: githubCI ?? Object.fromEntries(events
        .filter(event => event.type === 'github_ci_updated')
        .map(event => [event.nodeId, event.output])),
    }),

  setInspectedRunEvents: (inspectedRunEvents) => set({ inspectedRunEvents }),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
}));
