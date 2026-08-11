import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import FakeTimers, { type InstalledClock } from '@sinonjs/fake-timers';
import type { Workflow, WorkflowNode } from '../shared/workflow';
import {
  HISTORY_COALESCE_MS,
  HISTORY_LIMIT,
  normalizeWorkflowGeometry,
  useWorkflowStore,
} from './workflow-store-client';

function makeWorkflow(): Workflow {
  // Loop is placed clear of Start so loadWorkflow's geometry normalization
  // doesn't push Start away from the (0,0) the undo/redo tests assert on.
  // The Loop's default size is 460×240, so x=600 leaves a comfortable gap.
  const loop: WorkflowNode = {
    id: 'loop-1',
    type: 'loop',
    position: { x: 600, y: 0 },
    config: { maxIterations: 5, mode: 'while-not-met' },
    children: [],
  };
  const start: WorkflowNode = {
    id: 'start-1',
    type: 'start',
    position: { x: 0, y: 0 },
    config: {},
  };
  return {
    id: 'wf',
    name: 'WF',
    version: 1,
    nodes: [start, loop],
    edges: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  useWorkflowStore.setState({
    currentWorkflow: null,
    isDirty: false,
    selectedNodeId: null,
    runStatus: 'idle',
    runEvents: [],
    connectionStatus: 'connecting',
    panRequest: null,
    past: [],
    future: [],
  });
});

describe('requestPanToNode', () => {
  it('starts at seq=1 and advances on every call, even for the same node', () => {
    const s = () => useWorkflowStore.getState();
    expect(s().panRequest).toBeNull();
    s().requestPanToNode('agent-1');
    expect(s().panRequest).toEqual({ nodeId: 'agent-1', seq: 1 });
    s().requestPanToNode('agent-1');
    expect(s().panRequest).toEqual({ nodeId: 'agent-1', seq: 2 });
    s().requestPanToNode('cond-1');
    expect(s().panRequest).toEqual({ nodeId: 'cond-1', seq: 3 });
  });

  it('emits a new object reference per call so React effects re-fire', () => {
    const s = () => useWorkflowStore.getState();
    s().requestPanToNode('n1');
    const first = s().panRequest;
    s().requestPanToNode('n1');
    expect(s().panRequest).not.toBe(first);
  });
});

describe('appendRunEvent — run boundary', () => {
  it('drops the previous run\'s events when a new run_started arrives', () => {
    const s = useWorkflowStore.getState();
    s.appendRunEvent({ type: 'run_started', workflowId: 'w', workflowName: 'W' });
    s.appendRunEvent({
      type: 'node_started',
      nodeId: 'a',
      nodeType: 'agent',
      resolvedConfig: {},
    });
    s.appendRunEvent({ type: 'run_finished', status: 'succeeded', scope: {} });
    expect(useWorkflowStore.getState().runEvents).toHaveLength(3);

    // New run starts: previous events should be discarded so the panel only
    // ever shows the latest run.
    s.appendRunEvent({ type: 'run_started', workflowId: 'w', workflowName: 'W' });
    const after = useWorkflowStore.getState().runEvents;
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('run_started');
    expect(useWorkflowStore.getState().runStatus).toBe('running');
  });

  it('keeps appending non-run_started events to the current run', () => {
    const s = useWorkflowStore.getState();
    s.appendRunEvent({ type: 'run_started', workflowId: 'w', workflowName: 'W' });
    s.appendRunEvent({
      type: 'stdout_chunk',
      nodeId: 'a',
      line: 'hello',
    });
    expect(useWorkflowStore.getState().runEvents).toHaveLength(2);
  });
});

describe('addChildNode', () => {
  it('appends a child to the matching Loop and marks the workflow dirty', () => {
    const wf = makeWorkflow();
    useWorkflowStore.getState().loadWorkflow(wf);

    const child: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 20, y: 30 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };

    useWorkflowStore.getState().addChildNode('loop-1', child);

    const next = useWorkflowStore.getState().currentWorkflow!;
    const loop = next.nodes.find((n) => n.id === 'loop-1')!;
    expect(loop.children).toHaveLength(1);
    expect(loop.children![0].id).toBe('agent-1');
    expect(useWorkflowStore.getState().isDirty).toBe(true);
  });

  it('preserves existing children when appending', () => {
    const wf = makeWorkflow();
    const loop = wf.nodes.find((n) => n.id === 'loop-1')!;
    loop.children = [
      {
        id: 'existing',
        type: 'agent',
        position: { x: 0, y: 0 },
        config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
      },
    ];
    useWorkflowStore.getState().loadWorkflow(wf);

    const child: WorkflowNode = {
      id: 'agent-2',
      type: 'agent',
      position: { x: 20, y: 30 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };

    useWorkflowStore.getState().addChildNode('loop-1', child);

    const next = useWorkflowStore.getState().currentWorkflow!;
    const updatedLoop = next.nodes.find((n) => n.id === 'loop-1')!;
    expect(updatedLoop.children!.map((c) => c.id)).toEqual([
      'existing',
      'agent-2',
    ]);
  });

  it('no-ops when the parent id does not match any top-level node', () => {
    const wf = makeWorkflow();
    useWorkflowStore.getState().loadWorkflow(wf);

    const child: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };

    useWorkflowStore.getState().addChildNode('does-not-exist', child);

    const next = useWorkflowStore.getState().currentWorkflow!;
    const loop = next.nodes.find((n) => n.id === 'loop-1')!;
    expect(loop.children).toHaveLength(0);
  });
});

describe('normalizeWorkflowGeometry', () => {
  it('expands a Loop without `size` to fit its children plus padding', () => {
    // Reproduces the workflows/loop-claude-until-condition.json layout that
    // produced the visually-overlapping cards: Loop with no size, child
    // CONDITION sitting at child-local x=320 with width 220.
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: 'start-1',
          type: 'start',
          position: { x: 80, y: 200 },
          config: {},
        },
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 280, y: 120 },
          config: { maxIterations: 1, mode: 'while-not-met' },
          children: [
            {
              id: 'agent-1',
              type: 'agent',
              position: { x: 40, y: 60 },
              config: { providerId: 'claude', prompt: '', cwd: '/tmp', timeoutMs: 60000 },
            },
            {
              id: 'cond-1',
              type: 'condition',
              position: { x: 320, y: 60 },
              config: { kind: 'sentinel', sentinel: { pattern: 'OK', isRegex: false } },
            },
          ],
        },
        {
          id: 'end-1',
          type: 'end',
          position: { x: 760, y: 200 },
          config: { outcome: 'succeeded' },
        },
      ],
    };

    const out = normalizeWorkflowGeometry(wf);
    const loop = out.nodes.find((n) => n.id === 'loop-1')!;
    // Container must accommodate its widest child (cond-1 at child-local
    // right=540) plus the inner padding on both sides.
    expect(loop.size?.width ?? 0).toBeGreaterThanOrEqual(540);
  });

  it('pushes a top-level sibling out of a Loop whose new bbox engulfs it', () => {
    // Loop expands to ~588 wide; END at x=760 was just clear of the old 460
    // default but is now inside the new bbox. Must be pushed to the right.
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 280, y: 120 },
          config: { maxIterations: 1, mode: 'while-not-met' },
          children: [
            {
              id: 'cond-1',
              type: 'condition',
              position: { x: 320, y: 60 },
              config: { kind: 'sentinel', sentinel: { pattern: 'OK', isRegex: false } },
            },
          ],
        },
        {
          id: 'end-1',
          type: 'end',
          position: { x: 760, y: 200 },
          config: { outcome: 'succeeded' },
        },
      ],
    };

    const out = normalizeWorkflowGeometry(wf);
    const loop = out.nodes.find((n) => n.id === 'loop-1')!;
    const end = out.nodes.find((n) => n.id === 'end-1')!;
    const loopRight = (loop.position?.x ?? 0) + (loop.size?.width ?? 0);
    // END must end up clear of the loop's right edge.
    expect((end.position?.x ?? 0)).toBeGreaterThanOrEqual(loopRight);
  });

  it('preserves a Loop with a persisted size and a non-overlapping sibling', () => {
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 0, y: 0 },
          size: { width: 400, height: 200 },
          config: { maxIterations: 1, mode: 'while-not-met' },
        },
        {
          id: 'start-1',
          type: 'start',
          position: { x: 600, y: 0 },
          config: {},
        },
      ],
    };
    const out = normalizeWorkflowGeometry(wf);
    expect(out).toEqual(wf);
  });
});

describe('loadWorkflow + dirty marker', () => {
  it('marks the workflow dirty when normalize mutated geometry', () => {
    // Loop missing `size` triggers auto-fit, which mutates the workflow.
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 0, y: 0 },
          config: { maxIterations: 1, mode: 'while-not-met' },
          children: [
            {
              id: 'agent-1',
              type: 'agent',
              position: { x: 40, y: 60 },
              config: { providerId: 'claude', prompt: '', cwd: '/tmp', timeoutMs: 60000 },
            },
          ],
        },
      ],
    };
    useWorkflowStore.getState().loadWorkflow(wf);
    expect(useWorkflowStore.getState().isDirty).toBe(true);
    expect(
      useWorkflowStore.getState().currentWorkflow!.nodes.find((n) => n.id === 'loop-1')!.size,
    ).toBeDefined();
  });

  it('keeps the workflow clean when normalize was a no-op', () => {
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 0, y: 0 },
          size: { width: 460, height: 240 },
          config: { maxIterations: 1, mode: 'while-not-met' },
        },
        {
          id: 'start-1',
          type: 'start',
          position: { x: 600, y: 0 },
          config: {},
        },
      ],
    };
    useWorkflowStore.getState().loadWorkflow(wf);
    expect(useWorkflowStore.getState().isDirty).toBe(false);
  });
});

describe('undo / redo', () => {
  // Fake timers so we can step past the coalesce window deterministically.
  let clock: InstalledClock;
  beforeEach(() => {
    clock = FakeTimers.install({ now: 1_000_000 });
  });
  afterEach(() => {
    clock.uninstall();
  });

  function loadFresh(): Workflow {
    const wf = makeWorkflow();
    useWorkflowStore.getState().loadWorkflow(wf);
    return wf;
  }

  function step() {
    // Push the clock past the coalesce window so the next mutation is treated
    // as a new gesture, not a continuation.
    clock.tick(HISTORY_COALESCE_MS + 1);
  }

  it('undo restores the prior workflow snapshot', () => {
    loadFresh();
    step();
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 50, y: 60 } });
    expect(useWorkflowStore.getState().past).toHaveLength(1);

    useWorkflowStore.getState().undo();

    const wf = useWorkflowStore.getState().currentWorkflow!;
    expect(wf.nodes.find((n) => n.id === 'start-1')!.position).toEqual({ x: 0, y: 0 });
    expect(useWorkflowStore.getState().past).toHaveLength(0);
    expect(useWorkflowStore.getState().future).toHaveLength(1);
  });

  it('redo replays the snapshot popped by undo', () => {
    loadFresh();
    step();
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 50, y: 60 } });
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().future).toHaveLength(1);

    useWorkflowStore.getState().redo();

    const wf = useWorkflowStore.getState().currentWorkflow!;
    expect(wf.nodes.find((n) => n.id === 'start-1')!.position).toEqual({ x: 50, y: 60 });
    expect(useWorkflowStore.getState().future).toHaveLength(0);
  });

  it('any new mutation after undo wipes the redo stack', () => {
    loadFresh();
    step();
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 50, y: 60 } });
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().future).toHaveLength(1);

    step();
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 99, y: 99 } });

    expect(useWorkflowStore.getState().future).toHaveLength(0);
  });

  it('rapid mutations within the coalesce window collapse to one entry', () => {
    loadFresh();
    step();
    // Three position updates inside the same coalesce window — drag-like burst.
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 1, y: 1 } });
    clock.tick(50);
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 2, y: 2 } });
    clock.tick(50);
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 3, y: 3 } });

    expect(useWorkflowStore.getState().past).toHaveLength(1);

    useWorkflowStore.getState().undo();
    const wf = useWorkflowStore.getState().currentWorkflow!;
    // Undo should jump back to the pre-burst state, not to an intermediate value.
    expect(wf.nodes.find((n) => n.id === 'start-1')!.position).toEqual({ x: 0, y: 0 });
  });

  it('loadWorkflow resets both history stacks', () => {
    loadFresh();
    step();
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 7, y: 7 } });
    expect(useWorkflowStore.getState().past).toHaveLength(1);

    loadFresh();

    expect(useWorkflowStore.getState().past).toHaveLength(0);
    expect(useWorkflowStore.getState().future).toHaveLength(0);
  });

  it('caps the past stack at HISTORY_LIMIT entries', () => {
    loadFresh();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      step();
      useWorkflowStore.getState().updateNode('start-1', { position: { x: i, y: i } });
    }
    expect(useWorkflowStore.getState().past).toHaveLength(HISTORY_LIMIT);
  });

  it('undo / redo are no-ops on empty stacks', () => {
    loadFresh();
    const before = useWorkflowStore.getState().currentWorkflow;

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().currentWorkflow).toBe(before);

    useWorkflowStore.getState().redo();
    expect(useWorkflowStore.getState().currentWorkflow).toBe(before);
  });

  it('coalesce window slides — a long drag of sub-window ticks stays one entry', () => {
    loadFresh();
    step();
    // First push lands. Subsequent updates each 200ms apart (under the 250ms
    // window relative to the *previous* push, but >250ms from the original).
    // With a sliding window every tick advances the marker, so they all
    // coalesce into the single original entry.
    useWorkflowStore.getState().updateNode('start-1', { position: { x: 1, y: 1 } });
    for (let i = 2; i <= 10; i++) {
      clock.tick(200);
      useWorkflowStore.getState().updateNode('start-1', { position: { x: i, y: i } });
    }
    expect(useWorkflowStore.getState().past).toHaveLength(1);
  });

  it('every content-changing mutation pushes to past', () => {
    loadFresh();
    const start = () => useWorkflowStore.getState();

    step();
    start().setNodes([...start().currentWorkflow!.nodes]);
    expect(start().past).toHaveLength(1);

    step();
    start().setEdges([]);
    expect(start().past).toHaveLength(2);

    step();
    start().addNode({
      id: 'agent-x',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    });
    expect(start().past).toHaveLength(3);

    step();
    start().addChildNode('loop-1', {
      id: 'agent-child',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    });
    expect(start().past).toHaveLength(4);

    step();
    start().addEdge({
      id: 'e-x',
      source: 'start-1',
      sourceHandle: 'next',
      target: 'agent-x',
    });
    expect(start().past).toHaveLength(5);

    step();
    start().removeEdge('e-x');
    expect(start().past).toHaveLength(6);

    step();
    start().removeNode('agent-x');
    expect(start().past).toHaveLength(7);
  });

  it('undo restores edges that were cascade-removed alongside a node', () => {
    loadFresh();
    useWorkflowStore.getState().addChildNode('loop-1', {
      id: 'agent-child',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    });
    useWorkflowStore.getState().addEdge({
      id: 'e1',
      source: 'start-1',
      sourceHandle: 'next',
      target: 'loop-1',
    });
    useWorkflowStore.getState().addEdge({
      id: 'e2',
      source: 'agent-child',
      sourceHandle: 'next',
      target: 'start-1',
    });
    expect(useWorkflowStore.getState().currentWorkflow!.edges).toHaveLength(2);

    step();
    useWorkflowStore.getState().removeNode('loop-1');
    const afterRemove = useWorkflowStore.getState().currentWorkflow!;
    expect(afterRemove.nodes.find((n) => n.id === 'loop-1')).toBeUndefined();
    expect(afterRemove.edges).toHaveLength(0);

    useWorkflowStore.getState().undo();
    const restored = useWorkflowStore.getState().currentWorkflow!;
    expect(restored.nodes.find((n) => n.id === 'loop-1')).toBeDefined();
    expect(restored.edges).toEqual([
      { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
      { id: 'e2', source: 'agent-child', sourceHandle: 'next', target: 'start-1' },
    ]);
  });

  it('redo clears selection if the redone snapshot drops the selected node', () => {
    loadFresh();
    // Add then select a new node.
    step();
    useWorkflowStore.getState().addNode({
      id: 'agent-r',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    });
    useWorkflowStore.setState({ selectedNodeId: 'agent-r' });

    // Remove it — the snapshot pushed onto `past` here is the WITH-agent-r one.
    step();
    useWorkflowStore.getState().removeNode('agent-r');
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();

    // Undo: agent-r returns. Re-select it.
    useWorkflowStore.getState().undo();
    useWorkflowStore.setState({ selectedNodeId: 'agent-r' });

    // Redo: agent-r vanishes again — selection should clear.
    useWorkflowStore.getState().redo();
    expect(
      useWorkflowStore.getState().currentWorkflow!.nodes.find((n) => n.id === 'agent-r'),
    ).toBeUndefined();
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();
  });

  it('undo clears selection if the selected node no longer exists in the snapshot', () => {
    loadFresh();
    useWorkflowStore.setState({ selectedNodeId: 'agent-new' });

    step();
    const newAgent: WorkflowNode = {
      id: 'agent-new',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };
    useWorkflowStore.getState().addNode(newAgent);

    useWorkflowStore.getState().undo();

    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();
  });
});

describe('setWorkflowInputs', () => {
  it('replaces workflow.inputs and bumps updatedAt', () => {
    const wf = makeWorkflow(); // updatedAt: 0, no inputs
    useWorkflowStore.getState().loadWorkflow(wf);

    const decls = [{ name: 'topic', type: 'string' as const, default: 'cats' }];
    useWorkflowStore.getState().setWorkflowInputs(decls);

    const next = useWorkflowStore.getState().currentWorkflow!;
    expect(next.inputs).toEqual(decls);
    expect(next.updatedAt).toBeGreaterThanOrEqual(0);
  });

  it('clears inputs when passed an empty array', () => {
    const wf: Workflow = {
      ...makeWorkflow(),
      inputs: [{ name: 'topic', type: 'string' }],
    };
    useWorkflowStore.getState().loadWorkflow(wf);

    useWorkflowStore.getState().setWorkflowInputs([]);

    const next = useWorkflowStore.getState().currentWorkflow!;
    expect(next.inputs).toEqual([]);
  });

  // Regression: without isDirty, autosave (which watches the flag) never
  // fires after an inputs edit, so the API run reads a stale on-disk
  // workflow and the engine seeds an empty `inputs` scope — every
  // {{inputs.NAME}} ref then warns missingKey at runtime.
  it('marks the workflow dirty so autosave fires', () => {
    useWorkflowStore.getState().loadWorkflow(makeWorkflow());
    // loadWorkflow may set isDirty if geometry normalization mutated the
    // input; clear it so we observe only the setter's effect.
    useWorkflowStore.setState({ isDirty: false });

    useWorkflowStore
      .getState()
      .setWorkflowInputs([{ name: 'topic', type: 'string', default: 'cats' }]);

    expect(useWorkflowStore.getState().isDirty).toBe(true);
  });
});

describe('setGlobals', () => {
  // Same regression as setWorkflowInputs — globals edits must trigger
  // autosave so the run reads the updated declaration.
  it('marks the workflow dirty so autosave fires', () => {
    useWorkflowStore.getState().loadWorkflow(makeWorkflow());
    useWorkflowStore.setState({ isDirty: false });

    useWorkflowStore.getState().setGlobals({ KEY: 'value' });

    expect(useWorkflowStore.getState().isDirty).toBe(true);
  });
});

describe('setWorkflowCwd', () => {
  it('stores a global cwd, trims it, and marks the workflow dirty', () => {
    useWorkflowStore.getState().loadWorkflow(makeWorkflow());
    useWorkflowStore.setState({ isDirty: false });

    useWorkflowStore.getState().setWorkflowCwd('  /workspace/project  ');

    const current = useWorkflowStore.getState().currentWorkflow;
    expect(current?.cwd).toBe('/workspace/project');
    expect(useWorkflowStore.getState().isDirty).toBe(true);
  });

  it('clears blank global cwd values so execution uses /tmp', () => {
    useWorkflowStore.getState().loadWorkflow({
      ...makeWorkflow(),
      cwd: '/workspace/project',
    });

    useWorkflowStore.getState().setWorkflowCwd('   ');

    expect(useWorkflowStore.getState().currentWorkflow?.cwd).toBeUndefined();
  });
});
