import { afterAll, beforeEach, describe, expect, it, mock, spyOn, type Mock } from 'bun:test';
import type { RunSnapshot, Workflow } from '@/lib/shared/workflow';

// Snapshot the real modules before mocking so afterAll can re-publish them.
// Bun's mock.module persists for the rest of the test process, and it keys
// on specifier — so the alias `@/lib/server/workflow-store` mocked here is a
// distinct registration from a relative `./workflow-store` import elsewhere.
// Restoring keeps any future cross-file consumer of these aliases honest.
const realEngine = { ...(await import('@/lib/server/workflow-engine')) };
const realStore = { ...(await import('@/lib/server/workflow-store')) };

mock.module('@/lib/server/workflow-engine', () => ({
  workflowEngine: {
    start: mock(),
    stop: mock(),
    getState: mock(),
    getRun: mock(),
    list: mock(() => []),
    startRun: mock(() => ({ runId: 'mock-run', completion: Promise.resolve() })),
    slotPool: {
      getCapacity: () => 4,
      size: () => 0,
      waiterCount: () => 0,
    },
  },
}));

mock.module('@/lib/server/workflow-store', () => ({
  getWorkflow: mock(),
}));

const { workflowEngine } = await import('@/lib/server/workflow-engine');
const { getWorkflow } = await import('@/lib/server/workflow-store');
const { POST, GET } = await import('./route');
const { POST: STOP } = await import('./stop/route');

afterAll(() => {
  mock.module('@/lib/server/workflow-engine', () => realEngine);
  mock.module('@/lib/server/workflow-store', () => realStore);
});

const idleState: RunSnapshot = {
  status: 'idle',
  iterationByLoopId: {},
  scope: {},
};
const runningState: RunSnapshot = {
  status: 'running',
  iterationByLoopId: {},
  scope: {},
  workflowId: 'wf-1',
  startedAt: 1,
};

const sampleWorkflow: Workflow = {
  id: 'wf-1',
  name: 'sample',
  version: 1,
  nodes: [
    { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'end-1',
      type: 'end',
      position: { x: 0, y: 0 },
      config: { outcome: 'succeeded' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'start-1',
      sourceHandle: 'next',
      target: 'end-1',
    },
  ],
  createdAt: 0,
  updatedAt: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
const startMock = workflowEngine.start as unknown as AnyMock;
const startRunMock = (workflowEngine as unknown as { startRun: AnyMock }).startRun;
const stopMock = workflowEngine.stop as unknown as AnyMock;
const getStateMock = workflowEngine.getState as unknown as AnyMock;
const getWorkflowMock = getWorkflow as unknown as AnyMock;

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

beforeEach(() => {
  startMock.mockReset();
  startRunMock.mockReset();
  startRunMock.mockReturnValue({ runId: 'mock-run', completion: Promise.resolve() });
  stopMock.mockReset();
  getStateMock.mockReset();
  getWorkflowMock.mockReset();
  startMock.mockResolvedValue(undefined);
});

describe('POST /api/run', () => {
  it('starts the engine and returns 202 with state when idle', async () => {
    getWorkflowMock.mockResolvedValue(sampleWorkflow);
    getStateMock.mockReturnValue({ ...runningState, runId: 'mock-run' });
    startRunMock.mockReturnValue({ runId: 'mock-run', completion: Promise.resolve() });

    const res = await POST(jsonRequest({ workflowId: 'wf-1' }));

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      runId: string;
      correlationId: string;
      state: RunSnapshot;
    };
    expect(body.runId).toBe('mock-run');
    // A correlation id is minted at ingress, returned in the body, echoed on
    // the header, and threaded into the run.
    expect(body.correlationId).toMatch(/^cid_/);
    expect(res.headers.get('x-correlation-id')).toBe(body.correlationId);
    expect(getWorkflowMock).toHaveBeenCalledWith('wf-1');
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(startRunMock).toHaveBeenCalledWith(
      sampleWorkflow,
      expect.objectContaining({
        resolvedInputs: {},
        correlationId: body.correlationId,
      }),
    );
  });

  it('returns 400 when body is invalid JSON', async () => {
    const res = await POST(rawRequest('not-json{'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/json|workflowId/i);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns 400 when workflowId is missing or not a string', async () => {
    const res1 = await POST(jsonRequest({}));
    expect(res1.status).toBe(400);

    const res2 = await POST(jsonRequest({ workflowId: 123 }));
    expect(res2.status).toBe(400);

    const res3 = await POST(jsonRequest({ workflowId: '' }));
    expect(res3.status).toBe(400);

    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the workflow is not found', async () => {
    getWorkflowMock.mockRejectedValue(new Error('not found'));
    getStateMock.mockReturnValue(idleState);

    const res = await POST(jsonRequest({ workflowId: 'missing' }));

    expect(res.status).toBe(404);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('admits a new run even when another is already in flight (lazy slot model)', async () => {
    getWorkflowMock.mockResolvedValue(sampleWorkflow);
    getStateMock.mockReturnValue({ ...runningState, runId: 'rid-second' });
    startRunMock.mockReturnValue({ runId: 'rid-second', completion: Promise.resolve() });

    const res = await POST(jsonRequest({ workflowId: 'wf-1' }));

    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe('rid-second');
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });

  it('does not propagate run completion rejections back to the caller', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    getWorkflowMock.mockResolvedValue(sampleWorkflow);
    getStateMock.mockReturnValue({ ...runningState, runId: 'rid-boom' });
    // startRun returns synchronously; the completion promise rejects later.
    startRunMock.mockReturnValue({
      runId: 'rid-boom',
      completion: Promise.reject(new Error('boom')),
    });

    const res = await POST(jsonRequest({ workflowId: 'wf-1' }));

    expect(res.status).toBe(202);
    // Allow the caught microtask to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('includes runId in the 202 response when engine assigns one', async () => {
    getWorkflowMock.mockResolvedValue(sampleWorkflow);
    getStateMock.mockReturnValue({ ...runningState, runId: 'rid-abc' });
    startRunMock.mockReturnValue({ runId: 'rid-abc', completion: Promise.resolve() });

    const res = await POST(jsonRequest({ workflowId: 'wf-1' }));

    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId?: string; state: RunSnapshot };
    expect(body.runId).toBe('rid-abc');
  });

});

describe('GET /api/run', () => {
  it('returns 200 with the engine state', async () => {
    getStateMock.mockReturnValue(idleState);

    const res = await GET(new Request('http://localhost/api/run'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: RunSnapshot };
    expect(body.state).toEqual(idleState);
  });
});

describe('POST /api/run/stop', () => {
  it('calls engine.stop and returns 200 with state', async () => {
    getStateMock.mockReturnValue(idleState);

    const res = await STOP(new Request('http://localhost/api/run/stop', { method: 'POST' }));

    expect(res.status).toBe(200);
    expect(stopMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { state: RunSnapshot };
    expect(body.state).toEqual(idleState);
  });
});

describe('POST /api/run — input validation', () => {
  const workflowWithStringInput: Workflow = {
    id: 'wf-inputs-1',
    name: 'inputs test',
    version: 1,
    inputs: [{ name: 'topic', type: 'string' }],
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [],
    createdAt: 0,
    updatedAt: 0,
  };

  const workflowWithNumberInput: Workflow = {
    id: 'wf-inputs-2',
    name: 'inputs test number',
    version: 1,
    inputs: [{ name: 'count', type: 'number' }],
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [],
    createdAt: 0,
    updatedAt: 0,
  };

  it('returns 400 invalid-inputs when a required input is missing', async () => {
    getWorkflowMock.mockResolvedValue(workflowWithStringInput);
    getStateMock.mockReturnValue(idleState);

    const res = await POST(jsonRequest({ workflowId: 'wf-inputs-1' }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid-inputs');
    expect(body.field).toBe('topic');
    expect(body.reason).toBe('required');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns 400 invalid-inputs on type mismatch', async () => {
    getWorkflowMock.mockResolvedValue(workflowWithNumberInput);
    getStateMock.mockReturnValue(idleState);

    const res = await POST(
      jsonRequest({ workflowId: 'wf-inputs-2', inputs: { count: 'abc' } }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid-inputs');
    expect(body.field).toBe('count');
    expect(body.reason).toBe('type');
    expect(body.expected).toBe('number');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('accepts a valid inputs payload and starts the run', async () => {
    getWorkflowMock.mockResolvedValue(workflowWithStringInput);
    getStateMock
      .mockReturnValueOnce(idleState)
      .mockReturnValue({ ...runningState, runId: 'rid-ok' });

    const res = await POST(
      jsonRequest({ workflowId: 'wf-inputs-1', inputs: { topic: 'cats' } }),
    );

    expect(res.status).toBe(202);
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/run with INFLOOP_API_TOKEN', () => {
  const orig = process.env.INFLOOP_API_TOKEN;
  afterAll(() => {
    if (orig === undefined) delete process.env.INFLOOP_API_TOKEN;
    else process.env.INFLOOP_API_TOKEN = orig;
  });

  it('returns 401 without the bearer header', async () => {
    process.env.INFLOOP_API_TOKEN = 'shh';
    const res = await POST(jsonRequest({ workflowId: 'wf-1' }));
    expect(res.status).toBe(401);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('proceeds with the correct bearer header', async () => {
    process.env.INFLOOP_API_TOKEN = 'shh';
    getWorkflowMock.mockResolvedValue(sampleWorkflow);
    // First call: conflict guard (idle — allow start); second call: post-start state.
    getStateMock
      .mockReturnValueOnce(idleState)
      .mockReturnValueOnce({ ...runningState, runId: 'rid' });

    const req = new Request('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
  });
});
