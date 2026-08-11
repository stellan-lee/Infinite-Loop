import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  Workflow,
  WorkflowEvent,
  WorkflowNode,
} from '../../shared/workflow';

const realTemplating = { ...(await import('../templating')) };
const realRunStore = { ...(await import('../run-store')) };

mock.module('../templating', () => ({
  resolve: (text: string) => ({ text, warnings: [] }),
}));
mock.module('../run-store', () => ({
  saveRun: async () => undefined,
  historyLimit: () => 100,
  listRuns: async () => [],
  getRun: async () => {
    throw new Error('run not found');
  },
}));

const { WorkflowEngine } = await import('../workflow-engine');
const { eventBus } = await import('../event-bus');

afterAll(() => {
  mock.module('../templating', () => realTemplating);
  mock.module('../run-store', () => realRunStore);
});

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

function constExec(branch: EdgeHandle, outputs: Record<string, unknown> = {}): NodeExecutor {
  return {
    async execute() {
      return { branch, outputs };
    },
  };
}

function captureEvents(): { events: WorkflowEvent[]; off: () => void } {
  const events: WorkflowEvent[] = [];
  const off = eventBus.subscribe((e) => events.push(e));
  return { events, off };
}

const baseExecutors = () => ({
  start: constExec('next'),
  end: constExec('next'),
  agent: constExec('next'),
  condition: constExec('next'),
  loop: constExec('next'),
  parallel: constExec('next'),
  subworkflow: constExec('next'),
  branch: constExec('next'),
});

describe('parallel walker', () => {
  beforeEach(() => eventBus.clear());
  afterEach(() => eventBus.clear());

  it('identifies branch roots: every direct child with no internal inbound edge (2 children)', async () => {
    const a: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'wait-all', onError: 'fail-fast' },
      children: [a, b],
    };
    const wf: Workflow = {
      id: 'w',
      name: 'p',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        // Both 'a' and 'b' are branch roots — no internal edge between them.
        { id: 'e2', source: 'par-1', sourceHandle: 'all_done', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: constExec('next', { stdout: 'x' }),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    const out = eng.getState().scope['par-1'] as { children: Record<string, unknown>; completed: number };
    expect(Object.keys(out.children).sort()).toEqual(['a', 'b']);
    expect(out.completed).toBe(2);
  });

  it('identifies branch roots: 3 children where one is downstream of another', async () => {
    const a: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const a2: WorkflowNode = { id: 'a2', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'wait-all', onError: 'fail-fast' },
      children: [a, a2, b],
    };
    const wf: Workflow = {
      id: 'w',
      name: 'p3',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        // Internal edge: a → a2 makes a2 NOT a branch root.
        { id: 'eint', source: 'a', sourceHandle: 'next', target: 'a2' },
        { id: 'e2', source: 'par-1', sourceHandle: 'all_done', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: constExec('next', { stdout: 'ok' }),
    });
    await eng.start(wf);
    const out = eng.getState().scope['par-1'] as { children: Record<string, unknown> };
    // Two branch roots: 'a' (with a2 downstream) and 'b'.
    expect(Object.keys(out.children).sort()).toEqual(['a', 'b']);
  });

  it('wait-all routes all_done when every branch succeeds', async () => {
    const a: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'wait-all', onError: 'fail-fast' },
      children: [a, b],
    };
    const okEnd: WorkflowNode = { id: 'ok', type: 'end', position: { x: 0, y: 0 }, config: { outcome: 'succeeded' } };
    const wf: Workflow = {
      id: 'w',
      name: 'p',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, okEnd],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        { id: 'e2', source: 'par-1', sourceHandle: 'all_done', target: 'ok' },
      ],
    };
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: constExec('next', { stdout: 'hi' }),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
  });

  it('race cancels siblings; only the winner reaches its terminal node_finished', async () => {
    // Branch A finishes fast (5ms), Branch B is slow (200ms) — should be aborted.
    const a: WorkflowNode = { id: 'fast', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'slow', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'race', onError: 'fail-fast' },
      children: [a, b],
    };
    const wf: Workflow = {
      id: 'w',
      name: 'race',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        { id: 'e2', source: 'par-1', sourceHandle: 'first_done', target: 'end-1' },
      ],
    };
    // We need different executors per branch — use a shared map keyed by call order.
    let nextCallId = 0;
    const execImpl: NodeExecutor = {
      async execute(ctx) {
        const id = nextCallId++;
        // First started = fast, second = slow.
        const ms = id === 0 ? 5 : 200;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        return { branch: 'next' as EdgeHandle, outputs: { ms } };
      },
    };
    const eng = new WorkflowEngine({ ...baseExecutors(), agent: execImpl });
    const { events } = captureEvents();
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    const out = eng.getState().scope['par-1'] as {
      winner?: string;
      children: Record<string, { status: string }>;
    };
    expect(out.winner).toBeDefined();
    // Only the winner is exposed in `children` for race.
    expect(Object.keys(out.children).length).toBe(1);
    expect(out.children[out.winner!].status).toBe('succeeded');
    // Slow branch was cancelled — its node_finished, if any, should not be 'next'
    // for the slow node id; emit a finished event only for the winner.
    const finishedFastBranch = events.filter(
      (e) => e.type === 'node_finished' && (e as { nodeId: string }).nodeId === 'fast',
    );
    expect(finishedFastBranch.length).toBe(1);
  });

  it('quorum=2 succeeds when 2 of 3 branches finish', async () => {
    const a: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const c: WorkflowNode = { id: 'c', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'quorum', quorumN: 2, onError: 'fail-fast' },
      children: [a, b, c],
    };
    const wf: Workflow = {
      id: 'w',
      name: 'q',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        { id: 'e2', source: 'par-1', sourceHandle: 'quorum_met', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: constExec('next', { v: 1 }),
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    const out = eng.getState().scope['par-1'] as { winners?: string[] };
    expect(out.winners?.length).toBe(2);
  });

  it('quorum failure: too few successes routes error', async () => {
    const a: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'quorum', quorumN: 2, onError: 'best-effort' },
      children: [a, b],
    };
    const errEnd: WorkflowNode = {
      id: 'err',
      type: 'end',
      position: { x: 0, y: 0 },
      config: { outcome: 'failed' },
    };
    const wf: Workflow = {
      id: 'w',
      name: 'qf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, errEnd],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        { id: 'e2', source: 'par-1', sourceHandle: 'error', target: 'err' },
      ],
    };
    let i = 0;
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: {
        async execute() {
          // First branch succeeds, second fails. Need 2 → quorum not met.
          const callId = i++;
          if (callId === 0) return { branch: 'next' as EdgeHandle, outputs: {} };
          return { branch: 'error' as EdgeHandle, outputs: { errorMessage: 'nope' } };
        },
      },
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('failed');
  });

  it('fail-fast cancels siblings on first error', async () => {
    const a: WorkflowNode = { id: 'failer', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'sib', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'wait-all', onError: 'fail-fast' },
      children: [a, b],
    };
    const errEnd: WorkflowNode = {
      id: 'err',
      type: 'end',
      position: { x: 0, y: 0 },
      config: { outcome: 'failed' },
    };
    const wf: Workflow = {
      id: 'w',
      name: 'ff',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, errEnd],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        { id: 'e2', source: 'par-1', sourceHandle: 'error', target: 'err' },
      ],
    };
    let sibAborted = false;
    let i = 0;
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: {
        async execute(ctx) {
          const callId = i++;
          if (callId === 0) {
            // failer: errors quickly
            await new Promise((r) => setTimeout(r, 5));
            return { branch: 'error' as EdgeHandle, outputs: { errorMessage: 'boom' } };
          }
          // sibling: long-running, should be aborted
          try {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 500);
              ctx.signal.addEventListener('abort', () => {
                clearTimeout(t);
                sibAborted = true;
                reject(new Error('aborted'));
              });
            });
            return { branch: 'next' as EdgeHandle, outputs: {} };
          } catch (e) {
            sibAborted = true;
            throw e;
          }
        },
      },
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('failed');
    expect(sibAborted).toBe(true);
  });

  it('best-effort: surviving branch satisfies quorum even though one failed', async () => {
    const a: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const b: WorkflowNode = { id: 'b', type: 'agent', position: { x: 0, y: 0 }, config: {} as never };
    const par: WorkflowNode = {
      id: 'par-1',
      type: 'parallel',
      position: { x: 0, y: 0 },
      config: { mode: 'quorum', quorumN: 1, onError: 'best-effort' },
      children: [a, b],
    };
    const wf: Workflow = {
      id: 'w',
      name: 'be',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, par, endNode],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'par-1' },
        { id: 'e2', source: 'par-1', sourceHandle: 'quorum_met', target: 'end-1' },
      ],
    };
    let i = 0;
    const eng = new WorkflowEngine({
      ...baseExecutors(),
      agent: {
        async execute() {
          const id = i++;
          if (id === 0) return { branch: 'error' as EdgeHandle, outputs: { errorMessage: 'x' } };
          return { branch: 'next' as EdgeHandle, outputs: {} };
        },
      },
    });
    await eng.start(wf);
    expect(eng.getState().status).toBe('succeeded');
    const out = eng.getState().scope['par-1'] as { failed: number; completed: number };
    expect(out.failed).toBe(1);
    expect(out.completed).toBe(1);
  });
});
