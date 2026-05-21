import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  RunRecord,
  Workflow,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
} from '../shared/workflow';

/*
 * RunController failure-path coverage.
 *
 * The rest of the engine suite exercises the happy path and executors that
 * *return* the error branch; this file pins the two paths that were
 * previously untested:
 *
 *   1. An executor that *throws* — the engine must catch it, raise an
 *      `error` event, and route the run down the `error` edge (or settle
 *      `failed` when there is no handler).
 *   2. A required templated field (`CRITICAL_CONFIG_FIELDS`) whose `{{...}}`
 *      reference is unresolved — the engine must fail the node loudly onto
 *      its `error` branch instead of running the executor on a silently
 *      degraded value.
 *
 * Templating is left REAL here (that is the behavior under test); run-store
 * is stubbed so the tests never write run records or crash-recovery markers
 * to the project data dir.
 */
const realRunStore = { ...(await import('./run-store')) };
/** Run records the stubbed `saveRun` captured — lets the correlation-id tests
 *  inspect what RunController would have persisted without touching disk. */
const savedRecords: RunRecord[] = [];
mock.module('./run-store', () => ({
  ...realRunStore,
  saveRun: async (r: RunRecord) => {
    savedRecords.push(r);
  },
  writeRunMarker: () => undefined,
  removeRunMarker: async () => undefined,
}));

const { WorkflowEngine } = await import('./workflow-engine');
const { eventBus } = await import('./event-bus');

afterAll(() => {
  // Restore the real run-store so later test files share the genuine impl.
  mock.module('./run-store', () => realRunStore);
});

/** Executor that always settles on `branch` with optional outputs. */
function staticExec(
  branch: EdgeHandle,
  outputs: Record<string, unknown> = {},
): NodeExecutor {
  return {
    async execute() {
      return { branch, outputs };
    },
  };
}

/** Executor that records how many times it ran — used to assert a node was
 *  (or, for a degraded node, was NOT) executed. */
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

/** Executor that always throws — simulates a provider/runtime crash. */
function throwingExec(message: string): NodeExecutor {
  return {
    async execute() {
      throw new Error(message);
    },
  };
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

function edge(
  id: string,
  source: string,
  sourceHandle: EdgeHandle,
  target: string,
): WorkflowEdge {
  return { id, source, sourceHandle, target };
}

function wf(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf-test',
    name: 'failure-paths',
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

describe('RunController — thrown executor errors', () => {
  beforeEach(() => eventBus.clear());
  afterEach(() => eventBus.clear());

  it('routes a thrown executor error down the `error` edge to a handler', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp' },
    };
    const handler: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: {},
    };
    const handlerExec = spyExec('next');
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      agent: throwingExec('executor blew up'),
      condition: handlerExec,
      end: staticExec('next'),
    });

    const events = captureEvents();
    await eng.start(
      wf(
        [startNode, agent, handler, endNode],
        [
          edge('e1', 'start-1', 'next', 'agent-1'),
          edge('e2', 'agent-1', 'error', 'cond-1'),
          edge('e3', 'cond-1', 'next', 'end-1'),
        ],
      ),
    );

    expect(eng.getState().status).toBe('succeeded');
    // The error edge must actually carry the run into the handler node.
    expect(handlerExec.calls).toBe(1);

    const err = events.find((e) => e.type === 'error') as
      | { message: string }
      | undefined;
    expect(err?.message).toBe('executor blew up');
    // The thrown message is captured onto the failed node's scope outputs.
    expect(eng.getState().scope['agent-1']).toEqual({
      errorMessage: 'executor blew up',
    });
  });

  it('settles failed when a thrown executor error has no `error` edge', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'p', cwd: '/tmp' },
    };
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      agent: throwingExec('boom'),
      end: staticExec('next'),
    });

    const events = captureEvents();
    await eng.start(
      wf(
        [startNode, agent, endNode],
        [
          edge('e1', 'start-1', 'next', 'agent-1'),
          edge('e2', 'agent-1', 'next', 'end-1'),
        ],
      ),
    );

    expect(eng.getState().status).toBe('failed');
    expect(
      events.some(
        (e) => e.type === 'error' && (e as { message: string }).message === 'boom',
      ),
    ).toBe(true);
  });
});

describe('RunController — required (critical) template fields', () => {
  beforeEach(() => eventBus.clear());
  afterEach(() => eventBus.clear());

  it('fails a node loudly onto `error` when a required template field is unresolved', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'summarize {{ghost.value}}', cwd: '/tmp' },
    };
    const handler: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: {},
    };
    const agentExec = spyExec('next');
    const handlerExec = spyExec('next');
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      agent: agentExec,
      condition: handlerExec,
      end: staticExec('next'),
    });

    const events = captureEvents();
    await eng.start(
      wf(
        [startNode, agent, handler, endNode],
        [
          edge('e1', 'start-1', 'next', 'agent-1'),
          edge('e2', 'agent-1', 'error', 'cond-1'),
          edge('e3', 'cond-1', 'next', 'end-1'),
        ],
      ),
    );

    expect(eng.getState().status).toBe('succeeded');
    // The executor must never run on the silently degraded prompt.
    expect(agentExec.calls).toBe(0);
    expect(handlerExec.calls).toBe(1);

    const err = events.find((e) => e.type === 'error') as
      | { message: string }
      | undefined;
    expect(err).toBeTruthy();
    expect(err!.message).toContain('unresolved template reference');
    expect(err!.message).toContain('prompt');
    expect(err!.message).toContain('ghost.value');

    // A critical miss raises `error`, not a redundant `template_warning`.
    expect(events.some((e) => e.type === 'template_warning')).toBe(false);

    const finished = events.find(
      (e) =>
        e.type === 'node_finished' &&
        (e as { nodeType: string }).nodeType === 'agent',
    ) as { branch: EdgeHandle } | undefined;
    expect(finished?.branch).toBe('error');
  });

  it('settles failed when a required template field is unresolved and unhandled', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: '{{ghost.value}}', cwd: '/tmp' },
    };
    const agentExec = spyExec('next');
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      agent: agentExec,
      end: staticExec('next'),
    });

    const events = captureEvents();
    await eng.start(
      wf(
        [startNode, agent, endNode],
        [
          edge('e1', 'start-1', 'next', 'agent-1'),
          edge('e2', 'agent-1', 'next', 'end-1'),
        ],
      ),
    );

    expect(eng.getState().status).toBe('failed');
    expect(agentExec.calls).toBe(0);
    // The new critical-miss diagnostic wins — not agent.ts's generic
    // 'invalid agent config' (the executor never runs).
    const err = events.find((e) => e.type === 'error') as
      | { message: string }
      | undefined;
    expect(err?.message).toContain('unresolved template reference');
  });

  it('routes a critical-miss node inside a loop body to the run when unhandled', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: '{{ghost.value}}', cwd: '/tmp' },
    };
    const loop: WorkflowNode = {
      id: 'loop-1',
      type: 'loop',
      position: { x: 0, y: 0 },
      config: { maxIterations: 3, mode: 'unbounded' },
      children: [agent],
    };
    const agentExec = spyExec('next');
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      loop: staticExec('next'),
      agent: agentExec,
      end: staticExec('next'),
    });

    await eng.start(
      wf(
        [startNode, loop, endNode],
        [
          edge('e1', 'start-1', 'next', 'loop-1'),
          edge('e2', 'loop-1', 'next', 'end-1'),
        ],
      ),
    );

    // The critical-miss short-circuit yields `branch: 'error'`, which the
    // loop-body walk handles like any other error branch: no error edge in
    // the body → the run settles failed.
    expect(eng.getState().status).toBe('failed');
    expect(agentExec.calls).toBe(0);
  });

  it('keeps warn-and-continue behavior for a non-critical missing template field', async () => {
    const cond: WorkflowNode = {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: { against: '{{ghost.value}}' },
    };
    const condExec = spyExec('next');
    const eng = new WorkflowEngine({
      start: staticExec('next'),
      condition: condExec,
      end: staticExec('next'),
    });

    const events = captureEvents();
    await eng.start(
      wf(
        [startNode, cond, endNode],
        [
          edge('e1', 'start-1', 'next', 'cond-1'),
          edge('e2', 'cond-1', 'next', 'end-1'),
        ],
      ),
    );

    expect(eng.getState().status).toBe('succeeded');
    // A non-critical miss must NOT block the executor.
    expect(condExec.calls).toBe(1);

    const warn = events.find((e) => e.type === 'template_warning') as
      | { field: string; missingKey: string }
      | undefined;
    expect(warn?.field).toBe('against');
    expect(warn?.missingKey).toBe('ghost.value');
  });

  it('runs the executor normally when a required template field resolves', async () => {
    const agent: WorkflowNode = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { prompt: 'hello {{start-1.value}}', cwd: '/tmp' },
    };
    const agentExec = spyExec('next');
    const eng = new WorkflowEngine({
      start: staticExec('next', { value: 'world' }),
      agent: agentExec,
      end: staticExec('next'),
    });

    const events = captureEvents();
    await eng.start(
      wf(
        [startNode, agent, endNode],
        [
          edge('e1', 'start-1', 'next', 'agent-1'),
          edge('e2', 'agent-1', 'next', 'end-1'),
        ],
      ),
    );

    expect(eng.getState().status).toBe('succeeded');
    expect(agentExec.calls).toBe(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // The required field resolved against the start node's scope output.
    const started = events.find(
      (e) =>
        e.type === 'node_started' &&
        (e as { nodeType: string }).nodeType === 'agent',
    ) as { resolvedConfig: Record<string, unknown> } | undefined;
    expect(started?.resolvedConfig.prompt).toBe('hello world');
  });
});

describe('RunController — correlation id', () => {
  beforeEach(() => {
    eventBus.clear();
    savedRecords.length = 0;
  });
  afterEach(() => eventBus.clear());

  const trivialWf = wf(
    [startNode, endNode],
    [edge('e1', 'start-1', 'next', 'end-1')],
  );
  function trivialEngine() {
    return new WorkflowEngine({
      start: staticExec('next'),
      end: staticExec('next'),
    });
  }

  it('stamps the supplied correlation id onto every emitted event', async () => {
    const events = captureEvents();
    await trivialEngine().startRun(trivialWf, { correlationId: 'cid-supplied' })
      .completion;

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.correlationId === 'cid-supplied')).toBe(true);
    expect(events.find((e) => e.type === 'run_started')?.correlationId).toBe(
      'cid-supplied',
    );
    expect(events.find((e) => e.type === 'run_finished')?.correlationId).toBe(
      'cid-supplied',
    );
  });

  it('mints one correlation id for the whole run when none is supplied', async () => {
    const events = captureEvents();
    await trivialEngine().startRun(trivialWf).completion;

    const ids = new Set(events.map((e) => e.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^cid_/);
  });

  it('threads the correlation id into the persisted run record', async () => {
    await trivialEngine().startRun(trivialWf, { correlationId: 'cid-record' })
      .completion;
    // persistRun is fire-and-forget — poll for the stubbed saveRun to land
    // rather than racing a fixed-duration timer.
    for (let i = 0; savedRecords.length === 0 && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(savedRecords.at(-1)?.correlationId).toBe('cid-record');
  });
});
