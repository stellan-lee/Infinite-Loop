import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import type {
  AgentConfig,
  ConditionConfig,
  LoopConfig,
  Workflow,
  WorkflowEvent,
  WorkflowNode,
} from '../../../lib/shared/workflow';
import { useWorkflowStore } from '../../../lib/client/workflow-store-client';
import Canvas, {
  buildDroppedNode,
  buildEdge,
  buildLiveStateMap,
  defaultConfigFor,
  findContainingLoop,
  nextNodeId,
  pushOutsideLoops,
  pushSiblingsAfterLoopChange,
  workflowToXyflow,
} from './Canvas';

/* ─── jsdom polyfills required by xyflow ─────────────────────────────────── */

beforeEach(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  // Reset zustand singleton between tests.
  useWorkflowStore.setState({
    currentWorkflow: null,
    isDirty: false,
    selectedNodeId: null,
    runStatus: 'idle',
    runEvents: [],
    connectionStatus: 'connecting',
  });
});

afterEach(() => {
  cleanup();
});

/* ─── helpers / fixtures ─────────────────────────────────────────────────── */

function makeWorkflow(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: 'start-1',
      type: 'start',
      position: { x: 0, y: 0 },
      config: {},
    },
    {
      id: 'agent-1',
      type: 'agent',
      position: { x: 200, y: 0 },
      config: { providerId: 'claude', prompt: 'do thing', cwd: '/tmp', timeoutMs: 60000 },
    },
    {
      id: 'end-1',
      type: 'end',
      position: { x: 400, y: 0 },
      config: {},
    },
  ];
  return {
    id: 'wf-test',
    name: 'Test',
    version: 1,
    nodes,
    edges: [
      { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
      { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
}

/* ─── pure helper tests ──────────────────────────────────────────────────── */

describe('defaultConfigFor', () => {
  it('returns sensible defaults per node type', () => {
    expect(defaultConfigFor('start')).toEqual({});
    expect(defaultConfigFor('end')).toEqual({});
    const agent = defaultConfigFor('agent') as AgentConfig;
    expect(agent).toEqual({ providerId: 'claude', prompt: '', cwd: '', timeoutMs: 30 * 60 * 1000 });
    const condition = defaultConfigFor('condition') as ConditionConfig;
    expect(condition.kind).toBe('sentinel');
    expect(condition.sentinel).toEqual({ pattern: '', isRegex: false });
    const loop = defaultConfigFor('loop') as LoopConfig;
    expect(loop).toEqual({ maxIterations: 5, mode: 'while-not-met' });
  });
});

describe('nextNodeId', () => {
  it('starts at 1 when no nodes of that type exist', () => {
    expect(nextNodeId('agent', [])).toBe('agent-1');
  });

  it('picks max+1 across existing same-type ids', () => {
    const existing: WorkflowNode[] = [
      { id: 'agent-1', type: 'agent', position: { x: 0, y: 0 }, config: {} as AgentConfig },
      { id: 'agent-3', type: 'agent', position: { x: 0, y: 0 }, config: {} as AgentConfig },
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
    ];
    expect(nextNodeId('agent', existing)).toBe('agent-4');
    expect(nextNodeId('start', existing)).toBe('start-2');
    expect(nextNodeId('end', existing)).toBe('end-1');
  });

  it('counts nested child node ids as globally reserved', () => {
    const existing: WorkflowNode[] = [
      {
        id: 'loop-1',
        type: 'loop',
        position: { x: 0, y: 0 },
        config: { maxIterations: 5, mode: 'while-not-met' },
        children: [
          {
            id: 'agent-2',
            type: 'agent',
            position: { x: 0, y: 0 },
            config: {} as AgentConfig,
          },
        ],
      },
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 0, y: 0 },
        config: {} as AgentConfig,
      },
    ];
    expect(nextNodeId('agent', existing)).toBe('agent-3');
  });
});

describe('buildDroppedNode', () => {
  it('builds a node with default config and a unique id', () => {
    const node = buildDroppedNode(
      { type: 'agent', label: 'Step', providerId: 'claude' },
      { x: 50, y: 75 },
      [],
    );
    expect(node.id).toBe('agent-1');
    expect(node.type).toBe('agent');
    expect(node.position).toEqual({ x: 50, y: 75 });
    expect(node.label).toBe('Step');
    expect((node.config as AgentConfig).providerId).toBe('claude');
    expect((node.config as AgentConfig).timeoutMs).toBe(30 * 60 * 1000);
  });

  it('honors the dropped providerId on agent nodes', () => {
    const node = buildDroppedNode(
      { type: 'agent', providerId: 'codex' },
      { x: 0, y: 0 },
      [],
    );
    expect((node.config as AgentConfig).providerId).toBe('codex');
  });

  it('avoids id collisions by reading existing nodes', () => {
    const existing: WorkflowNode[] = [
      { id: 'loop-1', type: 'loop', position: { x: 0, y: 0 }, config: { maxIterations: 5, mode: 'while-not-met' } },
    ];
    const node = buildDroppedNode({ type: 'loop' }, { x: 0, y: 0 }, existing);
    expect(node.id).toBe('loop-2');
  });
});

describe('findContainingLoop', () => {
  const loop: WorkflowNode = {
    id: 'loop-1',
    type: 'loop',
    position: { x: 100, y: 100 },
    config: { maxIterations: 5, mode: 'while-not-met' },
    size: { width: 400, height: 200 },
  };

  it('returns null when the position is outside every Loop bbox', () => {
    expect(findContainingLoop({ x: 50, y: 50 }, [loop])).toBeNull();
  });

  it('returns the Loop whose bbox contains the position', () => {
    expect(findContainingLoop({ x: 200, y: 200 }, [loop])?.id).toBe('loop-1');
  });

  it('treats edge points as inside (inclusive bounds)', () => {
    expect(findContainingLoop({ x: 100, y: 100 }, [loop])).toBeTruthy();
    expect(findContainingLoop({ x: 500, y: 300 }, [loop])).toBeTruthy();
  });

  it('skips non-Loop nodes', () => {
    const sibling: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 100, y: 100 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };
    expect(findContainingLoop({ x: 110, y: 110 }, [sibling])).toBeNull();
  });
});

describe('pushOutsideLoops', () => {
  // 400×200 loop: vertical exit (≤100px) is always shorter than horizontal
  // exit for a 220×72 default card, so this exercises vertical pushes.
  const loop: WorkflowNode = {
    id: 'loop-1',
    type: 'loop',
    position: { x: 100, y: 100 },
    config: { maxIterations: 5, mode: 'while-not-met' },
    size: { width: 400, height: 200 }, // bbox: x=[100..500], y=[100..300]
  };
  // Tall loop: horizontal exits become the shortest path for cards in the
  // middle vertically.
  const tallLoop: WorkflowNode = {
    ...loop,
    id: 'loop-tall',
    size: { width: 400, height: 800 }, // bbox: y=[100..900]
  };

  it('returns the original position when there is no overlap', () => {
    const out = pushOutsideLoops(
      { id: 'agent-1', position: { x: 600, y: 50 } },
      [loop],
    );
    expect(out).toEqual({ x: 600, y: 50 });
  });

  it('pushes left when that is the shortest exit (tall loop, near left)', () => {
    // 220×72 candidate at x=120, y=400 inside tallLoop.
    // left push: lx - cw - x = 100 - 220 - 120 = -240 (dist 240)
    // right: 500 - 120 = 380 (dist 380); up: 100-72-400 = -372; down: 900-400 = 500
    // → left wins
    const out = pushOutsideLoops(
      { id: 'agent-1', position: { x: 120, y: 400 } },
      [tallLoop],
    );
    expect(out).toEqual({ x: -120, y: 400 });
  });

  it('pushes right when that is the shortest exit (tall loop, near right)', () => {
    // Candidate at x=450, y=400 in tallLoop. right push = 500 - 450 = 50.
    const out = pushOutsideLoops(
      { id: 'agent-1', position: { x: 450, y: 400 } },
      [tallLoop],
    );
    expect(out).toEqual({ x: 500, y: 400 });
  });

  it('pushes up when that is the shortest exit', () => {
    // Candidate at x=200, y=110 in original loop. up = 100-72-110 = -82 (dist 82);
    // down = 300-110 = 190; horizontal exits are even longer.
    const out = pushOutsideLoops(
      { id: 'agent-1', position: { x: 200, y: 110 } },
      [loop],
    );
    expect(out).toEqual({ x: 200, y: 28 });
  });

  it('pushes down when that is the shortest exit', () => {
    // Candidate at x=200, y=250 in original loop. up = -322; down = 300-250 = 50.
    const out = pushOutsideLoops(
      { id: 'agent-1', position: { x: 200, y: 250 } },
      [loop],
    );
    expect(out).toEqual({ x: 200, y: 300 });
  });

  it('skips itself when the candidate id matches a loop id', () => {
    const out = pushOutsideLoops(
      { id: 'loop-1', position: { x: 120, y: 200 } },
      [loop],
    );
    expect(out).toEqual({ x: 120, y: 200 });
  });

  it('ignores non-Loop nodes when checking overlap', () => {
    const sibling: WorkflowNode = {
      id: 'agent-2',
      type: 'agent',
      position: { x: 100, y: 100 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };
    const out = pushOutsideLoops(
      { id: 'agent-1', position: { x: 110, y: 110 } },
      [sibling],
    );
    expect(out).toEqual({ x: 110, y: 110 });
  });

  it('uses the candidate size when provided', () => {
    // 100×50 candidate at x=480, y=200 in original loop. right exit = 500 - 480 = 20.
    const out = pushOutsideLoops(
      {
        id: 'agent-1',
        position: { x: 480, y: 200 },
        size: { width: 100, height: 50 },
      },
      [loop],
    );
    expect(out).toEqual({ x: 500, y: 200 });
  });
});

describe('pushSiblingsAfterLoopChange', () => {
  function agentAt(id: string, x: number, y: number): WorkflowNode {
    return {
      id,
      type: 'agent',
      position: { x, y },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };
  }

  it('returns no updates when no sibling overlaps the new bbox', () => {
    const updates = pushSiblingsAfterLoopChange(
      { id: 'loop-1', x: 100, y: 100, width: 400, height: 800 },
      [agentAt('agent-1', 600, 400)],
    );
    expect(updates).toEqual([]);
  });

  it('returns updates for siblings now inside the Loop’s new bbox', () => {
    // Loop bbox covers (100..500, 100..900). Default 220×72 candidate at
    // (200, 400). Exits — left dist 320, right 300, up 372, down 500 — so
    // right wins, landing at x=500.
    const updates = pushSiblingsAfterLoopChange(
      { id: 'loop-1', x: 100, y: 100, width: 400, height: 800 },
      [agentAt('agent-1', 200, 400)],
    );
    expect(updates).toEqual([
      { id: 'agent-1', position: { x: 500, y: 400 } },
    ]);
  });

  it('skips the loop itself and other Loops', () => {
    const otherLoop: WorkflowNode = {
      id: 'loop-2',
      type: 'loop',
      position: { x: 200, y: 400 },
      config: { maxIterations: 1, mode: 'while-not-met' },
    };
    const self: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 100, y: 100 },
      config: { maxIterations: 1, mode: 'while-not-met' },
    };
    const updates = pushSiblingsAfterLoopChange(
      { id: 'loop-1', x: 100, y: 100, width: 400, height: 800 },
      [self, otherLoop, agentAt('agent-1', 200, 400)],
    );
    expect(updates.map((u) => u.id)).toEqual(['agent-1']);
  });

  it('respects the candidate sibling’s explicit size', () => {
    const sized: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 480, y: 200 },
      size: { width: 100, height: 50 },
      config: { providerId: 'claude', prompt: '', cwd: '', timeoutMs: 60000 },
    };
    const updates = pushSiblingsAfterLoopChange(
      { id: 'loop-1', x: 100, y: 100, width: 400, height: 200 },
      [sized],
    );
    // Right exit = 500 - 480 = 20; up = 100 - 50 - 200 = -150; down = 300 - 200 = 100
    // → right wins.
    expect(updates).toEqual([
      { id: 'agent-1', position: { x: 500, y: 200 } },
    ]);
  });
});

describe('buildEdge', () => {
  it('returns null when source or target is missing', () => {
    expect(buildEdge({ source: null, target: 'b', sourceHandle: null, targetHandle: null })).toBeNull();
    expect(buildEdge({ source: 'a', target: null, sourceHandle: null, targetHandle: null })).toBeNull();
  });

  it('builds a WorkflowEdge with an e_-prefixed id', () => {
    const e = buildEdge({
      source: 'start-1',
      target: 'agent-1',
      sourceHandle: 'next',
      targetHandle: null,
    });
    expect(e).not.toBeNull();
    expect(e!.source).toBe('start-1');
    expect(e!.target).toBe('agent-1');
    expect(e!.sourceHandle).toBe('next');
    expect(e!.id.startsWith('e_')).toBe(true);
    expect('targetHandle' in e!).toBe(false);
  });

  it("defaults sourceHandle to 'next' when xyflow passes null", () => {
    const e = buildEdge({
      source: 'a',
      target: 'b',
      sourceHandle: null,
      targetHandle: null,
    });
    expect(e!.sourceHandle).toBe('next');
  });
});

describe('buildLiveStateMap', () => {
  it('returns an empty map for no events', () => {
    expect(buildLiveStateMap([])).toEqual({});
  });

  it('marks started-but-not-finished as live', () => {
    const events: WorkflowEvent[] = [
      {
        type: 'node_started',
        nodeId: 'agent-1',
        nodeType: 'agent',
        resolvedConfig: {},
      },
    ];
    expect(buildLiveStateMap(events)).toEqual({ 'agent-1': 'live' });
  });

  it("marks finished as 'succeeded' or 'failed' based on branch", () => {
    const events: WorkflowEvent[] = [
      { type: 'node_started', nodeId: 'agent-1', nodeType: 'agent', resolvedConfig: {} },
      { type: 'node_finished', nodeId: 'agent-1', nodeType: 'agent', branch: 'next', outputs: {}, durationMs: 1 },
      { type: 'node_started', nodeId: 'agent-2', nodeType: 'agent', resolvedConfig: {} },
      { type: 'node_finished', nodeId: 'agent-2', nodeType: 'agent', branch: 'error', outputs: {}, durationMs: 1 },
      { type: 'node_started', nodeId: 'agent-3', nodeType: 'agent', resolvedConfig: {} },
    ];
    expect(buildLiveStateMap(events)).toEqual({
      'agent-1': 'succeeded',
      'agent-2': 'failed',
      'agent-3': 'live',
    });
  });
});

describe('workflowToXyflow', () => {
  it('returns empty arrays when workflow is null', () => {
    expect(workflowToXyflow(null, {}, null)).toEqual({ nodes: [], edges: [] });
  });

  it('maps nodes preserving id/type/position and packs data + state', () => {
    const wf = makeWorkflow();
    const out = workflowToXyflow(wf, { 'agent-1': 'live' }, 'agent-1');
    expect(out.nodes).toHaveLength(3);
    const agentOut = out.nodes.find((n) => n.id === 'agent-1');
    expect(agentOut?.type).toBe('agent');
    expect(agentOut?.selected).toBe(true);
    expect(agentOut?.data._state).toBe('live');
    // data.label is now undefined when the WorkflowNode has no custom
    // `label` (used to default to n.id, but that made it impossible for
    // the node component to tell "no custom name" apart from "name == id").
    expect(agentOut?.data.label).toBeUndefined();
    expect(agentOut?.data.config).toEqual({ providerId: 'claude', prompt: 'do thing', cwd: '/tmp', timeoutMs: 60000 });

    const startOut = out.nodes.find((n) => n.id === 'start-1');
    expect(startOut?.data._state).toBe('idle');
    expect(startOut?.selected).toBe(false);
  });

  it('maps edges 1:1 keeping handles', () => {
    const wf = makeWorkflow();
    const out = workflowToXyflow(wf, {}, null);
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0]).toMatchObject({
      id: 'e1',
      source: 'start-1',
      target: 'agent-1',
      sourceHandle: 'next',
    });
  });

  it('marks unvisited nodes as pending while a workflow run is active', () => {
    const wf = makeWorkflow();

    const out = workflowToXyflow(
      wf,
      {
        'start-1': 'succeeded',
        'agent-1': 'live',
      },
      null,
      null,
      'running',
    );

    expect(out.nodes.find((n) => n.id === 'start-1')?.data._state).toBe('succeeded');
    expect(out.nodes.find((n) => n.id === 'agent-1')?.data._state).toBe('live');
    expect(out.nodes.find((n) => n.id === 'end-1')?.data._state).toBe('pending');
  });

  it('auto-sizes a Loop without a persisted size to fit its children', () => {
    // Regression: a legacy workflow (Loop saved without `size`) used to fall
    // back to LOOP_DEFAULT_W=460 here, which is too narrow for a child sitting
    // at x=320 with width 220. xyflow's `extent: 'parent'` then clamped the
    // child leftward, stacking it on top of its sibling.
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
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
      ],
      edges: [],
    };

    const out = workflowToXyflow(wf, {}, null);
    const loop = out.nodes.find((n) => n.id === 'loop-1');
    const w = (loop?.style as { width?: number } | undefined)?.width ?? 0;

    // The condition's right edge sits at 320 + 220 = 540 in child-local
    // coordinates. The container needs at least that much room plus padding,
    // so the loop should expand well past the 460 default.
    expect(w).toBeGreaterThanOrEqual(540);
  });

  it("propagates a child's live state to its Loop container", () => {
    // The engine emits node_started for the child agent but never for the
    // Loop container itself, so without this propagation the Loop card stays
    // visually idle (gray dashed border) while a child is actively running —
    // creating a visual disconnect with the pulsing live child inside.
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 0, y: 0 },
          config: { maxIterations: 5, mode: 'while-not-met' },
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
      edges: [],
    };
    const liveOut = workflowToXyflow(wf, { 'agent-1': 'live' }, null);
    const loopLive = liveOut.nodes.find((n) => n.id === 'loop-1');
    const childLive = liveOut.nodes.find((n) => n.id === 'agent-1');
    expect(loopLive?.data._state).toBe('live');
    expect(childLive?.data._state).toBe('live');

    // When every child has run successfully, the Loop reads as already run too.
    const succeededOut = workflowToXyflow(wf, { 'agent-1': 'succeeded' }, null);
    expect(succeededOut.nodes.find((n) => n.id === 'loop-1')?.data._state).toBe('succeeded');
  });

  it('falls back to the default size when a Loop has no children', () => {
    const wf: Workflow = {
      id: 'wf',
      name: 'wf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'loop-empty',
          type: 'loop',
          position: { x: 0, y: 0 },
          config: { maxIterations: 1, mode: 'while-not-met' },
        },
      ],
      edges: [],
    };
    const out = workflowToXyflow(wf, {}, null);
    const loop = out.nodes.find((n) => n.id === 'loop-empty');
    const style = loop?.style as { width?: number; height?: number } | undefined;
    expect(style?.width).toBe(460);
    expect(style?.height).toBe(240);
  });
});

/* ─── component-level tests (xyflow DOM) ─────────────────────────────────── */

describe('<Canvas />', () => {
  it('renders without a current workflow', () => {
    const { container } = render(<Canvas />);
    // Canvas mounts with no nodes — the wrapper should be in the DOM and no node markers.
    expect(container.querySelector('[aria-label="canvas"]')).not.toBeNull();
    expect(container.querySelector('[data-id="start-1"]')).toBeNull();
  });

  it('renders xyflow nodes from the workflow store', () => {
    useWorkflowStore.getState().loadWorkflow(makeWorkflow());
    const { container } = render(<Canvas />);
    // xyflow renders each node with data-id="<nodeId>".
    expect(container.querySelector('[data-id="start-1"]')).not.toBeNull();
    expect(container.querySelector('[data-id="agent-1"]')).not.toBeNull();
    expect(container.querySelector('[data-id="end-1"]')).not.toBeNull();
  });

  // The pane-only right-click contract (right-click on a node should not
  // open the empty-canvas menu) is verified end-to-end in
  // tests/_e2e/context-menu.mjs against real Chromium. We skip a unit test
  // here because happy-dom's xyflow markup diverges from a real browser's
  // enough that the pane/node ancestor relationship can't be relied on.
});
