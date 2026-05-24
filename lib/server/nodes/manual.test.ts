import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  RunRecord,
  Workflow,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
} from '../../shared/workflow';

/*
 * Manual / human-acceptance gate engine integration tests.
 *
 * Pins the contract documented in the productized "manual" node:
 *   1. The gate parks the run via snapshot.waitingFor = { kind: 'human' }
 *      and emits `node_waiting_for_human`.
 *   2. A submitted decision routes through the matching outgoing edge
 *      and stores `{ decision, decidedBy, decidedAt, comment? }` on scope.
 *   3. An invalid / non-allowed decision is rejected without resolving the
 *      gate so a later valid decision still works.
 *   4. The configured timeout fabricates a `rejected` decision with
 *      `timedOut: true` and the run continues.
 *
 * The run-store is stubbed so the suite never touches disk; the controller
 * persistence path is exercised in its own suite.
 */
const realRunStore = { ...(await import('../run-store')) };
const savedRecords: RunRecord[] = [];
mock.module('../run-store', () => ({
  ...realRunStore,
  saveRun: async (r: RunRecord) => {
    savedRecords.push(r);
  },
  writeRunMarker: () => undefined,
  removeRunMarker: async () => undefined,
}));

const { WorkflowEngine } = await import('../workflow-engine');
const { eventBus } = await import('../event-bus');
const { manualExecutor } = await import('./manual');

function staticExec(branch: EdgeHandle): NodeExecutor {
  return {
    async execute() {
      return { branch, outputs: {} };
    },
  };
}

function spyExec(branch: EdgeHandle = 'next'): NodeExecutor & { calls: number } {
  const e: NodeExecutor & { calls: number } = {
    calls: 0,
    async execute() {
      e.calls++;
      return { branch, outputs: {} };
    },
  };
  return e;
}

const startNode: WorkflowNode = {
  id: 'start-1',
  type: 'start',
  position: { x: 0, y: 0 },
  config: {},
};
const endAccepted: WorkflowNode = {
  id: 'end-accepted',
  type: 'end',
  position: { x: 0, y: 0 },
  config: { outcome: 'succeeded' },
};
const endRejected: WorkflowNode = {
  id: 'end-rejected',
  type: 'end',
  position: { x: 0, y: 0 },
  config: { outcome: 'failed' },
};
const endNeedsChanges: WorkflowNode = {
  id: 'end-needs-changes',
  type: 'end',
  position: { x: 0, y: 0 },
  config: { outcome: 'succeeded' },
};

function edge(
  id: string,
  source: string,
  sourceHandle: EdgeHandle,
  target: string,
): WorkflowEdge {
  return { id, source, sourceHandle, target };
}

function manualNode(id = 'manual-1', extraCfg: Record<string, unknown> = {}): WorkflowNode {
  return {
    id,
    type: 'manual',
    position: { x: 0, y: 0 },
    config: {
      brief: 'Approve the change',
      decisions: [
        { key: 'accepted', label: 'Ship it' },
        { key: 'needs_changes' },
        { key: 'rejected' },
      ],
      ...extraCfg,
    },
  };
}

function wf(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf-manual',
    name: 'manual-tests',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
  };
}

function captureEvents(): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  eventBus.subscribe((e) => events.push(e));
  return events;
}

/** Wait until `pred()` returns true, polling every 5ms up to `timeoutMs`.
 *  Used to await the engine reaching the waiting-for-human state without
 *  racing on a microtask. */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('manual node — pause / resume', () => {
  beforeEach(() => {
    eventBus.clear();
    savedRecords.length = 0;
  });
  afterEach(() => eventBus.clear());

  it('parks the run on the gate and resumes through the chosen decision handle', async () => {
    const acceptedExec = spyExec('next');
    const rejectedExec = spyExec('next');
    const needsChangesExec = spyExec('next');

    const eng = new WorkflowEngine({
      start: staticExec('next'),
      manual: manualExecutor,
      end: { async execute() { return { branch: 'next', outputs: {} }; } },
      // Tap each terminal end node via its preceding end so we know which
      // branch ran. Easier: use spy execs for the end nodes themselves.
      // Bun's `NodeExecutor` mapping is keyed by type, so we can't
      // distinguish per-id. Instead, route each decision into a distinct
      // condition node and assert which spy fired.
      condition: { async execute() { return { branch: 'next', outputs: {} }; } },
    });

    // Replace the per-type single executor with a dispatcher that switches
    // on nodeId — lets us tell which downstream branch executed.
    const eng2 = new WorkflowEngine({
      start: staticExec('next'),
      manual: manualExecutor,
      end: staticExec('next'),
      condition: {
        async execute(ctx) {
          if (ctx.nodeId === 'cond-accepted') return acceptedExec.execute(ctx);
          if (ctx.nodeId === 'cond-rejected') return rejectedExec.execute(ctx);
          if (ctx.nodeId === 'cond-needs') return needsChangesExec.execute(ctx);
          return { branch: 'next', outputs: {} };
        },
      },
    });
    void eng; // silence unused

    const events = captureEvents();
    const workflow = wf(
      [
        startNode,
        manualNode(),
        {
          id: 'cond-accepted',
          type: 'condition',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'cond-rejected',
          type: 'condition',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'cond-needs',
          type: 'condition',
          position: { x: 0, y: 0 },
          config: {},
        },
        endAccepted,
        endRejected,
        endNeedsChanges,
      ],
      [
        edge('e1', 'start-1', 'next', 'manual-1'),
        edge('e2', 'manual-1', 'accepted', 'cond-accepted'),
        edge('e3', 'manual-1', 'rejected', 'cond-rejected'),
        edge('e4', 'manual-1', 'needs_changes', 'cond-needs'),
        edge('e5', 'cond-accepted', 'next', 'end-accepted'),
        edge('e6', 'cond-rejected', 'next', 'end-rejected'),
        edge('e7', 'cond-needs', 'next', 'end-needs-changes'),
      ],
    );

    const { runId, completion } = eng2.startRun(workflow);

    // Wait for the engine to reach the parked state. The snapshot must
    // expose the gate so polling clients see "waiting_for_human" rather
    // than think the run is hung.
    await waitFor(() => {
      const ctrl = eng2.getRun(runId);
      return ctrl?.snapshot.waitingFor?.kind === 'human';
    });

    const ctrl = eng2.getRun(runId)!;
    expect(ctrl.snapshot.status).toBe('running');
    expect(ctrl.snapshot.waitingFor).toMatchObject({
      kind: 'human',
      nodeId: 'manual-1',
      brief: 'Approve the change',
    });
    expect(ctrl.pendingHumanDecisions()).toHaveLength(1);

    // The waiting event must be on the bus so an SSE client could render
    // the gate without polling.
    expect(
      events.some((e) => e.type === 'node_waiting_for_human'),
    ).toBe(true);

    // Submit a valid decision.
    const result = ctrl.submitDecision({
      nodeId: 'manual-1',
      decision: 'accepted',
      comment: 'looks good',
      actor: 'api-token',
    });
    expect(result.ok).toBe(true);

    await completion;

    expect(eng2.getRun(runId)?.snapshot.status).toBe('succeeded');
    expect(acceptedExec.calls).toBe(1);
    expect(rejectedExec.calls).toBe(0);
    expect(needsChangesExec.calls).toBe(0);

    // The persisted scope carries the decision record so downstream
    // nodes can branch off `{{manual-1.decision}}` etc.
    const scope = eng2.getRun(runId)!.snapshot.scope['manual-1'];
    expect(scope).toMatchObject({
      decision: 'accepted',
      decidedBy: 'api-token',
      comment: 'looks good',
    });
    expect(typeof (scope as { decidedAt: unknown }).decidedAt).toBe('number');

    // The node_human_decided event reaches the bus with the actor +
    // comment so audit consumers / UI can display "who decided".
    const decided = events.find((e) => e.type === 'node_human_decided');
    expect(decided).toMatchObject({
      decision: 'accepted',
      decidedBy: 'api-token',
      comment: 'looks good',
    });
  });

  it('rejects an invalid decision without consuming the gate', async () => {
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      manual: manualExecutor,
      end: staticExec('next'),
    });

    captureEvents();
    const workflow = wf(
      [startNode, manualNode(), endAccepted],
      [
        edge('e1', 'start-1', 'next', 'manual-1'),
        edge('e2', 'manual-1', 'accepted', 'end-accepted'),
      ],
    );
    const { runId, completion } = eng.startRun(workflow);

    await waitFor(() => eng.getRun(runId)?.snapshot.waitingFor?.kind === 'human');
    const ctrl = eng.getRun(runId)!;

    // Non-existent key.
    const bogus = ctrl.submitDecision({
      nodeId: 'manual-1',
      decision: 'maybe',
      actor: 'api-token',
    });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) {
      expect(bogus.reason).toBe('invalid-decision');
    }
    // Wrong node id.
    const missingNode = ctrl.submitDecision({
      nodeId: 'manual-2',
      decision: 'accepted',
      actor: 'api-token',
    });
    expect(missingNode.ok).toBe(false);
    if (!missingNode.ok) expect(missingNode.reason).toBe('no-pending-decision');

    // Run is still parked.
    expect(ctrl.snapshot.waitingFor?.kind).toBe('human');

    // A valid decision finishes the gate.
    const ok = ctrl.submitDecision({
      nodeId: 'manual-1',
      decision: 'accepted',
      actor: 'api-token',
    });
    expect(ok.ok).toBe(true);

    await completion;
    expect(eng.getRun(runId)?.snapshot.status).toBe('succeeded');
    expect(eng.getRun(runId)?.snapshot.waitingFor).toBeUndefined();
  });

  it('routes through `rejected` with timedOut=true when the gate timer fires', async () => {
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      manual: manualExecutor,
      end: staticExec('next'),
    });

    captureEvents();
    const workflow = wf(
      [
        startNode,
        manualNode('manual-1', { timeoutMs: 30 }),
        endRejected,
      ],
      [
        edge('e1', 'start-1', 'next', 'manual-1'),
        edge('e2', 'manual-1', 'rejected', 'end-rejected'),
      ],
    );
    const { runId, completion } = eng.startRun(workflow);
    await completion;
    const ctrl = eng.getRun(runId)!;
    // The end node has outcome 'failed' so the run terminates as failed,
    // but the gate itself routed through rejected → that branch is what
    // surfaced the terminal outcome. Either way, the decision was recorded
    // with timedOut=true on the scope.
    expect(ctrl.snapshot.scope['manual-1']).toMatchObject({
      decision: 'rejected',
      decidedBy: 'system:timeout',
      timedOut: true,
    });
  });

  it('rejects decisions submitted after the run has settled', async () => {
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      manual: manualExecutor,
      end: staticExec('next'),
    });
    const workflow = wf(
      [startNode, manualNode('manual-1', { timeoutMs: 20 }), endRejected],
      [
        edge('e1', 'start-1', 'next', 'manual-1'),
        edge('e2', 'manual-1', 'rejected', 'end-rejected'),
      ],
    );
    const { runId, completion } = eng.startRun(workflow);
    await completion;
    const ctrl = eng.getRun(runId)!;
    const r = ctrl.submitDecision({
      nodeId: 'manual-1',
      decision: 'accepted',
      actor: 'api-token',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('run-not-running');
  });
});
