'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkflowStore } from '../../lib/client/workflow-store-client';
import { GroupedEventLog, formatPayload } from './RunLog';
import { eventNodeId } from '../../lib/client/group-events';
import type {
  ManualDecisionDecl,
  ManualDecisionKey,
  NodeStartedEvent,
  NodeWaitingForHumanEvent,
  Workflow,
  WorkflowEvent,
  WorkflowNode,
} from '../../lib/shared/workflow';
import { MANUAL_DECISION_KEYS } from '../../lib/shared/workflow';

const SUBWORKFLOW_PREF_KEY = 'infinite_loop:runview:expandSubworkflows';

/** Per-branch state derived from the event stream for one parallel child. */
interface BranchState {
  nodeId: string;
  nodeType: string;
  status: 'idle' | 'live' | 'succeeded' | 'failed' | 'cancelled';
  /** All stdout lines emitted by this branch, in arrival order. */
  stdoutLines: string[];
}

interface PendingManualGate {
  nodeId: string;
  brief: string;
  reviewerHint?: string;
  decisions: ManualDecisionDecl[];
  /** Approximate epoch-ms the gate started waiting (derived from the
   *  event index at parse time when no `since` is on the wire). */
  since: number;
}

const MANUAL_DECISION_DEFAULT_LABELS: Record<ManualDecisionKey, string> = {
  accepted: 'Accept',
  needs_changes: 'Needs changes',
  rejected: 'Reject',
};

/**
 * Walk events to derive the set of Manual gates currently awaiting a
 * human decision. A gate enters waiting on `node_waiting_for_human`,
 * leaves it on the matching `node_human_decided` (or `node_finished`,
 * which carries the same node id). The map keeps it O(n) and lets a
 * future workflow park multiple gates concurrently — common when a
 * parallel branch fans out reviewers.
 */
function findPendingManualGates(
  events: readonly WorkflowEvent[],
): PendingManualGate[] {
  const pending = new Map<string, PendingManualGate>();
  for (const ev of events) {
    if (ev.type === 'node_waiting_for_human') {
      const e = ev as NodeWaitingForHumanEvent;
      pending.set(e.nodeId, {
        nodeId: e.nodeId,
        brief: e.brief,
        reviewerHint: e.reviewerHint,
        decisions:
          e.decisions && e.decisions.length > 0
            ? e.decisions
            : MANUAL_DECISION_KEYS.map((key) => ({ key })),
        since: Date.now(),
      });
    } else if (ev.type === 'node_human_decided' || ev.type === 'node_finished') {
      if ('nodeId' in ev && typeof ev.nodeId === 'string') {
        pending.delete(ev.nodeId);
      }
    }
  }
  return Array.from(pending.values());
}

/**
 * Walk events to find each `node_started` not yet matched by a `node_finished`
 * for the same nodeId. The map keeps it O(n) and tolerates re-entry (loops).
 */
function findRunningNodeEvents(events: WorkflowEvent[]): NodeStartedEvent[] {
  const inFlight = new Map<string, NodeStartedEvent>();
  for (const ev of events) {
    if (ev.type === 'node_started') {
      inFlight.set(ev.nodeId, ev);
    } else if (ev.type === 'node_finished') {
      inFlight.delete(ev.nodeId);
    }
  }
  return Array.from(inFlight.values());
}

/** Walk the workflow node tree and return every nodeId, including descendants. */
function collectNodeIds(nodes: WorkflowNode[] | undefined): Set<string> {
  const out = new Set<string>();
  const stack: WorkflowNode[] = [...(nodes ?? [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.add(n.id);
    if (n.children && n.children.length > 0) stack.push(...n.children);
  }
  return out;
}

/**
 * Map every parallel container's node id → set of its direct child node ids,
 * by walking the workflow. Parallel children live in `node.children` per the
 * shared workflow shape.
 */
function findParallelChildIds(wf: Workflow | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!wf) return out;
  const stack: WorkflowNode[] = [...wf.nodes];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'parallel' && n.children && n.children.length > 0) {
      out.set(n.id, new Set(n.children.map((c) => c.id)));
    }
    if (n.children && n.children.length > 0) stack.push(...n.children);
  }
  return out;
}

/** Find subworkflow node ids in this workflow (top-level or descendants). */
function findSubworkflowNodeIds(wf: Workflow | null): Set<string> {
  const out = new Set<string>();
  if (!wf) return out;
  const stack: WorkflowNode[] = [...wf.nodes];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'subworkflow') out.add(n.id);
    if (n.children && n.children.length > 0) stack.push(...n.children);
  }
  return out;
}

/** Read `subworkflowStack` off an event if the engine tagged it. The shared
 * type doesn't declare the field yet (see U1), so we read it defensively. */
function eventSubworkflowStack(ev: WorkflowEvent): string[] | undefined {
  const stack = (ev as { subworkflowStack?: unknown }).subworkflowStack;
  if (Array.isArray(stack) && stack.length > 0) return stack as string[];
  return undefined;
}

/**
 * Build a per-branch state by replaying the event stream and only keeping
 * events whose nodeId is in `branchIds`. Branch status follows the obvious
 * lifecycle: live on `node_started`, terminal on `node_finished` or `error`.
 */
function deriveBranchStates(
  events: WorkflowEvent[],
  branchIds: Set<string>,
): BranchState[] {
  const byId = new Map<string, BranchState>();
  // Order branches by first appearance so the layout is stable and matches
  // the order events actually arrived.
  const order: string[] = [];
  for (const ev of events) {
    const nodeId = eventNodeId(ev);
    if (!nodeId || !branchIds.has(nodeId)) continue;
    let st = byId.get(nodeId);
    if (!st) {
      st = {
        nodeId,
        nodeType: ev.type === 'node_started' ? ev.nodeType : 'agent',
        status: 'idle',
        stdoutLines: [],
      };
      byId.set(nodeId, st);
      order.push(nodeId);
    }
    if (ev.type === 'node_started') {
      st.status = 'live';
      st.nodeType = ev.nodeType;
    } else if (ev.type === 'node_finished') {
      st.status = 'succeeded';
    } else if (ev.type === 'error') {
      st.status = 'failed';
    } else if (ev.type === 'stdout_chunk') {
      st.stdoutLines.push(ev.line);
    }
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * Render-list wrapper: take the full event stream and, when subworkflows are
 * collapsed, fold every event that's "internal to a subworkflow" into the
 * parent subworkflow node's slot so the user sees one card per subworkflow
 * instead of N internal cards.
 *
 * Detection:
 *   1) `subworkflowStack` event tag (preferred) — the deepest entry names the
 *      subworkflow node id whose run produced the event.
 *   2) Fallback by node-id provenance: an event whose nodeId is NOT a known
 *      node in the local workflow, while at least one subworkflow node exists,
 *      is attributed to the most-recently-started, still-in-flight
 *      subworkflow node (LIFO). This handles the common single-level nesting
 *      until U1 starts emitting `subworkflowStack`.
 *
 * When `expand` is true, events pass through untouched.
 */
function applySubworkflowCollapse(
  events: WorkflowEvent[],
  wf: Workflow | null,
  expand: boolean,
): WorkflowEvent[] {
  if (expand) return events;
  const subIds = findSubworkflowNodeIds(wf);
  if (subIds.size === 0) return events;
  const localIds = collectNodeIds(wf?.nodes);

  const out: WorkflowEvent[] = [];
  // Stack of currently in-flight subworkflow node ids, in start order. Top of
  // stack is the parent attribution for fallback events.
  const subStack: string[] = [];

  for (const ev of events) {
    const stackTag = eventSubworkflowStack(ev);
    const evNodeId = eventNodeId(ev);

    // Path 1: explicit tag from engine.
    if (stackTag) {
      const owner = stackTag[0];
      if (subIds.has(owner)) {
        // Re-attribute as a stdout line on the owning subworkflow card so it
        // shows up under that one card. We keep it generic by stringifying.
        out.push(folded(owner, ev));
        continue;
      }
    }

    // Track our LIFO stack of in-flight subworkflow node ids (used by the
    // fallback path). This is independent of whether we end up folding the
    // event — the bookkeeping has to mirror engine lifecycle.
    if (ev.type === 'node_started' && subIds.has(ev.nodeId)) {
      subStack.push(ev.nodeId);
    } else if (ev.type === 'node_finished' && subIds.has(ev.nodeId)) {
      const idx = subStack.lastIndexOf(ev.nodeId);
      if (idx >= 0) subStack.splice(idx, 1);
    }

    // Path 2: fallback. An event with a nodeId not in the local workflow,
    // while a subworkflow is in flight, is treated as subworkflow-internal.
    if (
      evNodeId &&
      !localIds.has(evNodeId) &&
      subStack.length > 0 &&
      ev.type !== 'run_started' &&
      ev.type !== 'run_finished'
    ) {
      const owner = subStack[subStack.length - 1];
      out.push(folded(owner, ev));
      continue;
    }

    out.push(ev);
  }
  return out;
}

/** Fold one internal event into a stdout-style line attributed to `owner`.
 * Keeping the surface tiny (one row) is the point — the user opted out of
 * seeing internal cards. The original event type prefix preserves enough
 * context to debug without exploding into a full sub-card. */
function folded(owner: string, ev: WorkflowEvent): WorkflowEvent {
  if (ev.type === 'stdout_chunk') {
    return { type: 'stdout_chunk', nodeId: owner, line: ev.line };
  }
  return {
    type: 'stdout_chunk',
    nodeId: owner,
    line: `[${ev.type}] ${formatPayload(ev)}`,
  };
}

/** Last 2 non-empty lines of a branch's stdout, joined for the live preview. */
function tailPreview(lines: string[]): string {
  // The provider runner emits chunks that may be partial-token deltas, so
  // concatenating preserves the source text either way; we then split on
  // newlines and keep the trailing 1-2 non-empty lines for the snippet.
  const text = lines.join('');
  const split = text.split('\n').filter((l) => l.length > 0);
  return split.slice(-2).join('\n');
}

export default function RunView() {
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const runEvents = useWorkflowStore((s) => s.runEvents);
  const connectionStatus = useWorkflowStore((s) => s.connectionStatus);
  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);

  // Re-render on every animation frame while running so the elapsed-time
  // counter steps smoothly instead of jumping by 0.2-0.3s every interval
  // tick. rAF naturally pauses when the tab is backgrounded.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (runStatus !== 'running') return;
    let raf = 0;
    const loop = () => {
      setTick((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [runStatus]);

  // Subworkflow collapse preference. Default: collapsed (expand=false). The
  // preference persists across page loads; we read it lazily so SSR doesn't
  // touch `localStorage`. The state is the source of truth after mount; the
  // localStorage write keeps it sticky.
  const [expandSubworkflows, setExpandSubworkflows] = useState(false);
  const [prefHydrated, setPrefHydrated] = useState(false);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(SUBWORKFLOW_PREF_KEY);
      if (v === '1') setExpandSubworkflows(true);
      else if (v === '0') setExpandSubworkflows(false);
    } catch {
      // ignore: private mode / disabled storage just means non-sticky
    }
    setPrefHydrated(true);
  }, []);
  useEffect(() => {
    if (!prefHydrated) return;
    try {
      window.localStorage.setItem(
        SUBWORKFLOW_PREF_KEY,
        expandSubworkflows ? '1' : '0',
      );
    } catch {
      // ignore — same reason as above
    }
  }, [expandSubworkflows, prefHydrated]);

  // Stick the log to the bottom while the user is reading the latest output,
  // but stop yanking them down if they have scrolled up to inspect history.
  // Re-engages once they scroll back near the bottom. The 48px threshold (~2
  // wrapped stdout lines) keeps streaming chunks from flipping us out of
  // stickiness when the user is essentially at the bottom.
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    // Immunize against the synthetic scroll event the assignment above fires
    // — without this, a slightly off-by-one scrollTop value during the
    // browser's scroll-into-place could flip stickToBottom to false.
    stickToBottomRef.current = true;
  }, [runEvents.length]);
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 48;
  };

  const running = useMemo(
    () => findRunningNodeEvents(runEvents),
    [runEvents],
  );

  const pendingGates = useMemo(
    () => findPendingManualGates(runEvents),
    [runEvents],
  );
  // runId rides on every run-scoped event the controller emits. Pulled
  // here so the decision panel can post to /api/runs/<wfId>/<runId>/decision
  // without the store needing a dedicated `currentRunId` field.
  const runId = useMemo(() => {
    for (const ev of runEvents) {
      const r = (ev as { runId?: unknown }).runId;
      if (typeof r === 'string') return r;
    }
    return null;
  }, [runEvents]);

  const parallelChildIds = useMemo(
    () => findParallelChildIds(currentWorkflow),
    [currentWorkflow],
  );

  // Track the wall-clock time at which each in-flight node was first seen so
  // the elapsed counter does not reset whenever an unrelated event arrives.
  const startedAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const startedAt = startedAtRef.current;
    const liveIds = new Set(running.map((e) => e.nodeId));
    for (const ev of running) {
      if (!startedAt.has(ev.nodeId)) startedAt.set(ev.nodeId, Date.now());
    }
    for (const id of startedAt.keys()) {
      if (!liveIds.has(id)) startedAt.delete(id);
    }
  }, [running]);

  const visibleEvents = useMemo(
    () =>
      applySubworkflowCollapse(runEvents, currentWorkflow, expandSubworkflows),
    [runEvents, currentWorkflow, expandSubworkflows],
  );

  // Memoized once per (events, parallel topology) pair so the rAF tick that
  // drives the elapsed counter doesn't re-walk the full event list per
  // parallel parent. Empty when no parallel container is currently in flight.
  const branchesByParent = useMemo(() => {
    const out = new Map<string, BranchState[]>();
    for (const ev of running) {
      const childIds = parallelChildIds.get(ev.nodeId);
      if (childIds && childIds.size > 0) {
        out.set(ev.nodeId, deriveBranchStates(runEvents, childIds));
      }
    }
    return out;
  }, [running, parallelChildIds, runEvents]);

  return (
    <aside aria-label="run view" className="run-view">
      <header className="run-view-head">
        <span className="pill" aria-label="run status" data-status={runStatus}>
          <span className="dot" /> {runStatus}
        </span>
        <button
          type="button"
          className="btn btn-toggle"
          aria-label="toggle subworkflow expansion"
          aria-pressed={expandSubworkflows}
          title={
            expandSubworkflows
              ? 'Subworkflow events: showing all'
              : 'Subworkflow events: collapsed into parent'
          }
          onClick={() => setExpandSubworkflows((v) => !v)}
        >
          Subflow: {expandSubworkflows ? 'all' : 'off'}
        </button>
        <span className="run-view-ws" aria-label="event stream status">
          SSE: {connectionStatus}
        </span>
      </header>

      {pendingGates.length > 0 && currentWorkflow && runId ? (
        <div className="run-view-gates" aria-label="awaiting human decision">
          {pendingGates.map((gate) => (
            <ManualGatePanel
              key={gate.nodeId}
              gate={gate}
              workflowId={currentWorkflow.id}
              runId={runId}
            />
          ))}
        </div>
      ) : null}

      {running.length > 0 ? (
        <div className="run-view-current" aria-label="currently running">
          {running.map((ev) => {
            const since = startedAtRef.current.get(ev.nodeId) ?? Date.now();
            const elapsed = Date.now() - since;
            const branches = branchesByParent.get(ev.nodeId) ?? [];
            return (
              <div key={ev.nodeId} className="run-view-current-row-group">
                <div className="run-view-current-row">
                  <span className="tag" data-kind="live">
                    <span className="dot" /> {ev.nodeType}
                  </span>
                  <span className="run-view-current-id">{ev.nodeId}</span>
                  <span className="run-view-current-elapsed">
                    {(elapsed / 1000).toFixed(1)}s
                  </span>
                </div>
                {branches.length > 0 ? (
                  <ul
                    className="run-view-branches"
                    aria-label={`parallel branches of ${ev.nodeId}`}
                  >
                    {branches.map((b) => (
                      <BranchRow
                        key={b.nodeId}
                        branch={b}
                        parentId={ev.nodeId}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div
        ref={logRef}
        className="run-view-log"
        aria-label="event log"
        onScroll={onLogScroll}
      >
        <GroupedEventLog events={visibleEvents} />
      </div>
    </aside>
  );
}

/**
 * Inline panel for a Manual / human-acceptance gate that is currently
 * parked. Lets the reviewer pick a decision and (optionally) attach a
 * comment, then posts to `/api/runs/<wf>/<run>/decision`.
 *
 * Productized: never references any specific reviewer / agent / persona.
 * The 'authorized reviewer' identity is whatever the API token / session
 * cookie represents — single-tenant by design.
 */
function ManualGatePanel({
  gate,
  workflowId,
  runId,
}: {
  gate: PendingManualGate;
  workflowId: string;
  runId: string;
}) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState<ManualDecisionKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: ManualDecisionKey) => {
    if (submitting) return;
    setSubmitting(decision);
    setError(null);
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: gate.nodeId,
            decision,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
          }),
        },
      );
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) detail = data.error;
        } catch {
          // best effort
        }
        throw new Error(detail);
      }
      // The matching node_human_decided event will clear the gate from
      // `pendingGates` and unmount this panel — no local cleanup needed.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'submit failed');
      setSubmitting(null);
    }
  };

  return (
    <section
      className="run-view-gate"
      aria-label={`manual gate ${gate.nodeId}`}
      data-status="waiting_for_human"
    >
      <header className="run-view-gate-head">
        <span className="pill" data-status="waiting_for_human">
          <span className="dot" /> waiting_for_human
        </span>
        <span className="run-view-gate-id">{gate.nodeId}</span>
      </header>
      {gate.brief ? (
        <pre className="run-view-gate-brief" aria-label="acceptance brief">
          {gate.brief}
        </pre>
      ) : (
        <p className="run-view-gate-brief run-view-gate-brief--empty">
          (no brief — author left it blank)
        </p>
      )}
      {gate.reviewerHint ? (
        <p className="run-view-gate-hint">
          Reviewer: <strong>{gate.reviewerHint}</strong>
        </p>
      ) : null}
      <label className="run-view-gate-comment">
        <span>Comment (optional)</span>
        <textarea
          aria-label="decision comment"
          rows={2}
          maxLength={4000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={submitting !== null}
        />
      </label>
      <div className="run-view-gate-buttons">
        {gate.decisions.map((decl) => {
          const label =
            decl.label ?? MANUAL_DECISION_DEFAULT_LABELS[decl.key] ?? decl.key;
          return (
            <button
              key={decl.key}
              type="button"
              className="btn"
              data-decision={decl.key}
              aria-label={`submit ${decl.key}`}
              onClick={() => submit(decl.key)}
              disabled={submitting !== null}
              title={decl.description ?? undefined}
            >
              {submitting === decl.key ? `${label}…` : label}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="run-view-gate-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Sub-row rendered under a running parallel node for one of its child
 * branches. Defaults collapsed showing the last 1-2 stdout lines; click
 * expands to the full branch stream. */
function BranchRow({ branch, parentId }: { branch: BranchState; parentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => tailPreview(branch.stdoutLines), [branch.stdoutLines]);
  const full = useMemo(() => branch.stdoutLines.join(''), [branch.stdoutLines]);
  const cardLabel = `branch ${branch.nodeId} of ${parentId}`;

  return (
    <li className="run-view-branch" aria-label={cardLabel} data-state={branch.status}>
      <button
        type="button"
        className="run-view-branch-head"
        aria-label={
          expanded
            ? `collapse ${cardLabel}`
            : `expand ${cardLabel}`
        }
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="run-view-branch-id">{branch.nodeId}</span>
        <span className="run-view-branch-kind">{branch.nodeType}</span>
        <span
          className="pill"
          data-status={branch.status}
          aria-label={`status ${branch.status}`}
        >
          <span className="dot" /> {branch.status}
        </span>
      </button>
      {!expanded && branch.status === 'live' && preview ? (
        <pre
          className="run-view-branch-preview"
          aria-label={`live preview ${branch.nodeId}`}
        >
          {preview}
        </pre>
      ) : null}
      {expanded ? (
        <pre
          className="run-view-branch-full"
          aria-label={`full stdout ${branch.nodeId}`}
        >
          {full}
        </pre>
      ) : null}
    </li>
  );
}
