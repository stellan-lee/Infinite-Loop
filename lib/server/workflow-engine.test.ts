import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  Workflow,
  WorkflowEvent,
  WorkflowNode,
} from '../shared/workflow';
import type { ResolvedInputs } from '../shared/resolve-run-inputs';

// Capture the real modules up front; bun's `mock.module` is global to the
// test process and replaces live ESM bindings, so anything captured AFTER the
// mock would itself be the mock.
const realTemplating = { ...(await import('./templating')) };
const realRunStore = { ...(await import('./run-store')) };

mock.module('./templating', () => ({
  resolve: (text: string) => ({ text, warnings: [] }),
}));

// Stub run-store so engine tests don't write real run records to the project
// cwd. The persist call is fire-and-forget inside start(), so tests that
// don't care can ignore this stub entirely.
mock.module('./run-store', () => ({
  saveRun: async () => undefined,
  historyLimit: () => 100,
  listRuns: async () => [],
  getRun: async () => {
    throw new Error('run not found');
  },
}));

const { WorkflowEngine } = await import('./workflow-engine');
const { eventBus } = await import('./event-bus');

afterAll(() => {
  // Restore the real modules so other test files in the same Bun process see
  // the genuine implementations.
  mock.module('./templating', () => realTemplating);
  mock.module('./run-store', () => realRunStore);
});

function exec(branchByCall: EdgeHandle[], outputs: Record<string, unknown> = {}): NodeExecutor {
  let i = 0;
  return {
    async execute() {
      const branch = branchByCall[i] ?? branchByCall[branchByCall.length - 1];
      i++;
      return { outputs, branch };
    },
  };
}

function captureEvents(): { events: WorkflowEvent[]; off: () => void } {
  const events: WorkflowEvent[] = [];
  const off = eventBus.subscribe((e) => events.push(e));
  return { events, off };
}

const startNode: WorkflowNode = {
  id: 'start-1',
  type: 'start',
  position: { x: 0, y: 0 },
  config: {},
};
const endNode: WorkflowNode = {
  id: 'end-1',
  type: 'end',
  position: { x: 0, y: 0 },
  config: {},
};

describe('WorkflowEngine', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  it('runs a linear Start → Claude → End and settles succeeded', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const wf: Workflow = {
      id: 'w1',
      name: 'lin',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, agent, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
        { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next'], { stdout: 'hello', exitCode: 0 }),
      condition: exec(['next']),
      loop: exec(['next']),
    });

    const { events } = captureEvents();
    await eng.start(wf);

    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().scope['agent-1']).toEqual({ stdout: 'hello', exitCode: 0 });
    expect(events.find((e) => e.type === 'run_started')).toBeTruthy();
    expect(events.find((e) => e.type === 'run_finished' && (e as { status: string }).status === 'succeeded')).toBeTruthy();
  });

  it('routes a Condition met branch to End and not_met branch back', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const cond: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: { kind: 'sentinel', sentinel: { pattern: 'X', isRegex: false } },
    };
    const wf: Workflow = {
      id: 'w2',
      name: 'cond',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, agent, cond, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
        { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'cond-1' },
        { id: 'e3', source: 'cond-1', sourceHandle: 'met', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next']),
      condition: exec(['met'], { met: true, detail: 'matched' }),
      loop: exec(['next']),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().scope['cond-1']).toEqual({ met: true, detail: 'matched' });
  });

  it('walks a Loop body until the condition fires break (met)', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const cond: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: { kind: 'sentinel', sentinel: { pattern: 'X', isRegex: false } },
    };
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 5, mode: 'while-not-met' },
      children: [agent, cond],
    };
    const wf: Workflow = {
      id: 'w3',
      name: 'loop',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
        { id: 'e3', source: 'agent-1', sourceHandle: 'next', target: 'cond-1' },
        // Condition has no edges: met → fall back to break, not_met → continue.
      ],
    };
    // condition emits not_met twice, then met on the third iteration
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next', 'next', 'next']),
      condition: exec(['not_met', 'not_met', 'met']),
      loop: exec(['next']),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().iterationByLoopId['loop-1']).toBe(3);
  });

  it('caps iterations at maxIterations and falls through past the loop', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const cond: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: { kind: 'sentinel', sentinel: { pattern: 'X', isRegex: false } },
    };
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 2, mode: 'while-not-met' },
      children: [agent, cond],
    };
    const wf: Workflow = {
      id: 'w4',
      name: 'cap',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
        { id: 'e3', source: 'agent-1', sourceHandle: 'next', target: 'cond-1' },
      ],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next', 'next', 'next']),
      condition: exec(['not_met', 'not_met', 'not_met']),
      loop: exec(['next']),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().iterationByLoopId['loop-1']).toBe(2);
  });

  it('ignores maxIterations when infinite: true and exits via break', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const cond: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: { kind: 'sentinel', sentinel: { pattern: 'X', isRegex: false } },
    };
    // Tiny cap, but infinite: true should override it.
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 2, mode: 'while-not-met', infinite: true },
      children: [agent, cond],
    };
    const wf: Workflow = {
      id: 'w-inf',
      name: 'inf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
        { id: 'e3', source: 'agent-1', sourceHandle: 'next', target: 'cond-1' },
      ],
    };
    // 7× not_met then met → 8 iterations, well past maxIterations=2.
    const condBranches: EdgeHandle[] = [
      'not_met', 'not_met', 'not_met', 'not_met',
      'not_met', 'not_met', 'not_met', 'met',
    ];
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next']),
      condition: exec(condBranches),
      loop: exec(['next']),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().iterationByLoopId['loop-1']).toBe(8);
  });

  it('infinite Loop blows past maxIterations and cancels via stop()', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    // maxIterations: 1 — without infinite, would settle after a single iteration.
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 1, mode: 'unbounded', infinite: true },
      children: [agent],
    };
    const wf: Workflow = {
      id: 'w-inf-cancel',
      name: 'inf-cancel',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };

    // Agent self-stops the engine on the 5th call. If the cap were honored
    // we'd never reach the 5th call (only one iteration).
    let calls = 0;
    let engRef: { stop: () => void } | null = null;
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: {
        async execute() {
          calls++;
          if (calls === 5) engRef!.stop();
          return { branch: 'next' as EdgeHandle, outputs: {} };
        },
      },
      condition: exec(['next']),
      loop: exec(['next']),
    });
    engRef = eng;

    await eng.start(wf);

    expect(eng.getState().status).toBe('cancelled');
    expect(eng.getState().iterationByLoopId['loop-1']).toBe(5);
  });

  it('infinite Loop terminates when its body hits an end node', async () => {
    const innerEnd: WorkflowNode = {
      id: 'end-inner',
      type: 'end',
      position: { x: 0, y: 0 },
      config: { outcome: 'succeeded' },
    };
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 1, mode: 'unbounded', infinite: true },
      children: [innerEnd],
    };
    const wf: Workflow = {
      id: 'w-inf-end',
      name: 'inf-end',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next']),
      condition: exec(['next']),
      loop: exec(['next']),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
  });

  it('settles failed when an executor returns the error branch with no handler', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const wf: Workflow = {
      id: 'w5',
      name: 'err',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, agent, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
        { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['error'], { errorMessage: 'boom' }),
      condition: exec(['next']),
      loop: exec(['next']),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('failed');
  });

  it('cancels mid-run when stop() is called', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const wf: Workflow = {
      id: 'w6',
      name: 'cancel',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, agent, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
        { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    let resolveExec: ((value: { branch: EdgeHandle; outputs: Record<string, unknown> }) => void) | null = null;
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: {
        execute: () =>
          new Promise<{ branch: EdgeHandle; outputs: Record<string, unknown> }>((resolve) => {
            resolveExec = resolve;
          }),
      },
      condition: exec(['next']),
      loop: exec(['next']),
    });

    const runPromise = eng.start(wf);
    await new Promise((r) => setTimeout(r, 20));
    eng.stop();
    resolveExec!({ branch: 'next', outputs: {} });
    await runPromise;

    expect(eng.getState().status).toBe('cancelled');
  });

  it('allows multiple concurrent runs (stage 1b: size-1 guard removed)', async () => {
    const wf: Workflow = {
      id: 'w7',
      name: 'concurrent',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, endNode],
      edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
    };
    // Each start-node invocation parks until a per-call release is signalled.
    const releases: Array<() => void> = [];
    const eng = new WorkflowEngine({
      start: {
        execute: () =>
          new Promise<{ branch: EdgeHandle; outputs: Record<string, unknown> }>((resolve) => {
            releases.push(() => resolve({ branch: 'next', outputs: {} }));
          }),
      },
      end: exec(['next']),
      agent: exec(['next']),
      condition: exec(['next']),
      loop: exec(['next']),
    });
    const first = eng.start(wf);
    const second = eng.start(wf);
    // Both runs must be alive in the registry simultaneously.
    await new Promise((r) => setTimeout(r, 5));
    expect(eng.list().length).toBe(2);
    // Release both; both must settle as 'succeeded'.
    releases[0]?.();
    releases[1]?.();
    await Promise.all([first, second]);
    expect(eng.list().length).toBe(0);
    expect(eng.getState().status).toBe('succeeded');
  });
});

describe('WorkflowEngine — workflow inputs', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  it('seeds resolved inputs into scope under `inputs`', async () => {
    const wf: Workflow = {
      id: 'w-inputs-1',
      name: 'inputs-seed',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, endNode],
      edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next']),
      condition: exec(['next']),
      loop: exec(['next']),
    });

    const resolvedInputs: ResolvedInputs = { topic: 'cats' };
    await eng.start(wf, { resolvedInputs });

    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().scope.inputs).toEqual({ topic: 'cats' });
  });

  it('omits scope.inputs entirely when none supplied and none declared', async () => {
    const wf: Workflow = {
      id: 'w-inputs-2',
      name: 'inputs-none',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, endNode],
      edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
    };
    const eng = new WorkflowEngine({
      start: exec(['next']),
      end: exec(['next']),
      agent: exec(['next']),
      condition: exec(['next']),
      loop: exec(['next']),
    });

    await eng.start(wf);

    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().scope.inputs).toBeUndefined();
  });
});

describe('WorkflowEngine — subworkflow child inputs alias', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  it('exposes parent-supplied inputs under both `inputs` and `__inputs`', async () => {
    // Child workflow: start → end (trivial; we only care about scope seeding).
    const childWf: Workflow = {
      id: 'child-wf',
      name: 'child',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'start-c', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'end-c', type: 'end', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [{ id: 'ec1', source: 'start-c', sourceHandle: 'next', target: 'end-c' }],
    };

    // Subworkflow node that:
    //   - passes `topic: 'cats'` to the child
    //   - copies `inputs.topic` and `__inputs.topic` back as named outputs
    const subwfNode: WorkflowNode = {
      id: 'sub-1',
      type: 'subworkflow',
      position: { x: 0, y: 0 },
      config: {
        workflowId: 'child-wf',
        inputs: { topic: 'cats' },
        outputs: {
          topicViaInputs: 'inputs.topic',
          topicViaLegacy: '__inputs.topic',
        },
      },
    };

    // Parent workflow: start → subworkflow → end
    const parentWf: Workflow = {
      id: 'parent-wf',
      name: 'parent',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'start-p', type: 'start', position: { x: 0, y: 0 }, config: {} },
        subwfNode,
        { id: 'end-p', type: 'end', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'ep1', source: 'start-p', sourceHandle: 'next', target: 'sub-1' },
        { id: 'ep2', source: 'sub-1', sourceHandle: 'next', target: 'end-p' },
      ],
    };

    const eng = new WorkflowEngine(
      {
        start: exec(['next']),
        end: exec(['next']),
        agent: exec(['next']),
        condition: exec(['next']),
        loop: exec(['next']),
      },
      async (id: string) => {
        if (id === 'child-wf') return childWf;
        throw new Error(`unknown workflow: ${id}`);
      },
    );

    await eng.start(parentWf);

    expect(eng.getState().status).toBe('succeeded');
    // Both `inputs.topic` and `__inputs.topic` must have been present in the
    // child scope for the output-copy mechanism to populate these keys.
    expect(eng.getState().scope['sub-1']).toMatchObject({
      status: 'succeeded',
      topicViaInputs: 'cats',
      topicViaLegacy: 'cats',
    });
  });
});

describe('runId on snapshot', () => {
  it('exposes runId after start() and keeps it on terminal status', async () => {
    const engine = new WorkflowEngine();
    expect(engine.getState().runId).toBeUndefined();

    const wf: Workflow = {
      id: 'wf-runid',
      name: 'runid test',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'e', type: 'end', position: { x: 0, y: 0 }, config: { outcome: 'succeeded' } },
      ],
      edges: [{ id: 'e1', source: 's', sourceHandle: 'next', target: 'e' }],
    };
    await engine.start(wf);

    const after = engine.getState();
    expect(typeof after.runId).toBe('string');
    expect(after.runId!.length).toBeGreaterThan(8);
    expect(after.status).toBe('succeeded');
  });

  it('overwrites runId on the next start()', async () => {
    const engine = new WorkflowEngine();
    const wf: Workflow = {
      id: 'wf-runid-2',
      name: 'runid test 2',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'e', type: 'end', position: { x: 0, y: 0 }, config: { outcome: 'succeeded' } },
      ],
      edges: [{ id: 'e1', source: 's', sourceHandle: 'next', target: 'e' }],
    };
    await engine.start(wf);
    const first = engine.getState().runId;
    await engine.start(wf);
    const second = engine.getState().runId;
    expect(second).not.toBe(first);
  });
});

describe('WorkflowEngine — run-level execution budget', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  const passthroughExecutors = (): Record<string, NodeExecutor> => ({
    start: exec(['next']),
    end: exec(['next']),
    agent: exec(['next']),
    condition: exec(['next']),
    loop: exec(['next']),
  });

  /** start → loop(infinite, body=[agent]) → end. The agent has no outgoing
   *  edge, so every iteration falls through to `continue` and the loop spins
   *  forever — the run only ends when something stops it. */
  function infiniteLoopWorkflow(id: string): Workflow {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 1, mode: 'unbounded', infinite: true },
      children: [agent],
    };
    return {
      id,
      name: id,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
  }

  /** start → loop(maxIterations=200, body=[agent]) → end. A *finite* loop —
   *  used to prove the budget catches oversized bounded runs too. */
  function finiteLoopWorkflow(id: string): Workflow {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
    };
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 200, mode: 'unbounded' },
      children: [agent],
    };
    return {
      id,
      name: id,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, loop, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
  }

  it('fails an infinite loop once the node-execution budget is exceeded', async () => {
    const eng = new WorkflowEngine(passthroughExecutors(), undefined, {
      runBudget: { maxNodeExecutions: 50 },
    });
    const { events } = captureEvents();

    await eng.start(infiniteLoopWorkflow('w-budget-inf'));

    // Reclassified as `failed` — NOT `cancelled`, which would misattribute a
    // runaway loop to the user pressing stop.
    expect(eng.getState().status).toBe('failed');
    expect(eng.getState().errorMessage).toContain('node-execution budget');
    expect(
      events.some(
        (e) =>
          e.type === 'error' &&
          (e as { message: string }).message.includes('node-execution budget'),
      ),
    ).toBe(true);
  });

  it('also trips on a finite but oversized run', async () => {
    const eng = new WorkflowEngine(passthroughExecutors(), undefined, {
      runBudget: { maxNodeExecutions: 50 },
    });

    await eng.start(finiteLoopWorkflow('w-budget-finite'));

    // maxIterations=200 would settle on its own, but 200 node steps blow the
    // 50-step ceiling first.
    expect(eng.getState().status).toBe('failed');
    expect(eng.getState().errorMessage).toContain('node-execution budget');
  });

  it('treats maxNodeExecutions: 0 as disabled', async () => {
    const eng = new WorkflowEngine(passthroughExecutors(), undefined, {
      runBudget: { maxNodeExecutions: 0, maxDurationMs: 0 },
    });

    await eng.start(finiteLoopWorkflow('w-budget-disabled'));

    // The same 200-iteration loop that failed above now runs to completion.
    expect(eng.getState().status).toBe('succeeded');
    expect(eng.getState().iterationByLoopId['loop-1']).toBe(200);
  });

  it('enforces the wall-clock duration ceiling', async () => {
    const executors = passthroughExecutors();
    executors.agent = {
      async execute() {
        await new Promise((r) => setTimeout(r, 5));
        return { branch: 'next' as EdgeHandle, outputs: {} };
      },
    };
    const eng = new WorkflowEngine(executors, undefined, {
      // Node ceiling clears the ~3 steps this run takes before the duration
      // cap trips, but stays low enough that a duration-check regression
      // fails fast with a wrong-message assertion instead of spinning.
      runBudget: { maxNodeExecutions: 500, maxDurationMs: 1 },
    });

    await eng.start(infiniteLoopWorkflow('w-budget-wallclock'));

    expect(eng.getState().status).toBe('failed');
    expect(eng.getState().errorMessage).toContain('wall-clock budget');
  });

  it('allows a run that exactly meets the node budget', async () => {
    // start → agent → end is exactly 3 node steps.
    const wf: Workflow = {
      id: 'w-budget-exact',
      name: 'budget-exact',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'agent-1',
          type: 'agent',
          position: { x: 0, y: 0 },
          config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
        { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };

    // Budget == step count: the run must still succeed (the ceiling trips
    // only when the count goes *over* the limit).
    const exactEng = new WorkflowEngine(passthroughExecutors(), undefined, {
      runBudget: { maxNodeExecutions: 3 },
    });
    await exactEng.start(wf);
    expect(exactEng.getState().status).toBe('succeeded');

    // One under: the 3rd step is one too many.
    const underEng = new WorkflowEngine(passthroughExecutors(), undefined, {
      runBudget: { maxNodeExecutions: 2 },
    });
    await underEng.start(wf);
    expect(underEng.getState().status).toBe('failed');
    expect(underEng.getState().errorMessage).toContain('node-execution budget');
  });
});
