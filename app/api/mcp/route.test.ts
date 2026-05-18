import { afterAll, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import type { RunSnapshot, Workflow } from '@/lib/shared/workflow';

// Snapshot real modules before mocking so afterAll can restore them.
const realWorkflowStore = { ...(await import('@/lib/server/workflow-store')) };
const realWorkflowEngine = { ...(await import('@/lib/server/workflow-engine')) };

mock.module('@/lib/server/workflow-store', () => ({
  listWorkflows: mock(),
  getWorkflow: mock(),
}));

mock.module('@/lib/server/workflow-engine', () => ({
  workflowEngine: {
    start: mock(),
    stop: mock(),
    getState: mock(),
    getRun: mock(),
    list: mock(() => []),
    startRun: mock(() => ({ runId: 'mock-run', completion: Promise.resolve() })),
  },
}));

const { listWorkflows, getWorkflow } = await import('@/lib/server/workflow-store');
const { workflowEngine } = await import('@/lib/server/workflow-engine');
const { POST } = await import('./route');

afterAll(() => {
  mock.module('@/lib/server/workflow-store', () => realWorkflowStore);
  mock.module('@/lib/server/workflow-engine', () => realWorkflowEngine);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
const listWorkflowsMock = listWorkflows as unknown as AnyMock;
const getWorkflowMock = getWorkflow as unknown as AnyMock;
const getStateMock = workflowEngine.getState as unknown as AnyMock;

const idleSnap: RunSnapshot = {
  status: 'idle',
  iterationByLoopId: {},
  scope: {},
};

const sampleWorkflow: Workflow = {
  id: 'wf-sample',
  name: 'Sample Workflow',
  version: 1,
  nodes: [
    { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
    { id: 'end-1', type: 'end', position: { x: 100, y: 0 }, config: { outcome: 'succeeded' } },
  ],
  edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
  createdAt: 0,
  updatedAt: 0,
};

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

beforeEach(() => {
  listWorkflowsMock.mockReset();
  getWorkflowMock.mockReset();
  getStateMock.mockReset();
  // Default: no workflows discovered.
  listWorkflowsMock.mockResolvedValue([]);
  getStateMock.mockReturnValue(idleSnap);
});

// ─── initialize ───────────────────────────────────────────────────────────────

describe('POST /api/mcp — initialize', () => {
  it('returns 200 with protocolVersion, serverInfo, and capabilities', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown };
    };
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.serverInfo).toBeDefined();
    expect(body.result.capabilities).toBeDefined();
  });
});

// ─── notifications ────────────────────────────────────────────────────────────

describe('POST /api/mcp — notifications', () => {
  it('returns 204 for notifications/initialized (no id field)', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    );
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns 204 for any other notification (e.g. notifications/cancelled)', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }),
    );
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns 204 for an unknown notification method without sending an error', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', method: 'notifications/unknown_future_method' }),
    );
    expect(res.status).toBe(204);
  });
});

// ─── tools/list ───────────────────────────────────────────────────────────────

describe('POST /api/mcp — tools/list', () => {
  it('returns 200 with result.tools as an array', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(Array.isArray(body.result.tools)).toBe(true);
  });

  it('always includes the canonical infinite_loop_* utility tools', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('infinite_loop_get_run_status');
    expect(names).toContain('infinite_loop_list_runs');
    expect(names).toContain('infinite_loop_cancel_run');
  });

  it('does not advertise the legacy inflooop_* names in tools/list', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).not.toContain('inflooop_get_run_status');
    expect(names).not.toContain('inflooop_list_runs');
    expect(names).not.toContain('inflooop_cancel_run');
  });

  it('includes discovered workflow tools alongside utility tools', async () => {
    listWorkflowsMock.mockResolvedValueOnce([{ id: 'wf-sample', name: 'Sample Workflow' }]);
    getWorkflowMock.mockResolvedValueOnce(sampleWorkflow);

    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('wf_sample');
    // Canonical utility tools still present.
    expect(names).toContain('infinite_loop_get_run_status');
  });

  it('still dispatches calls made with the legacy inflooop_* names', async () => {
    const res = await POST(
      mcpRequest({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'inflooop_list_queue', arguments: {} },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { code: number; message: string };
    };
    // Legacy names dispatch the same handler — must not return Unknown tool / RPC error.
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.type).toBe('text');
  });
});

// ─── parse error ─────────────────────────────────────────────────────────────

describe('POST /api/mcp — parse error', () => {
  it('returns HTTP 200 with JSON-RPC parse error envelope on bad JSON', async () => {
    const res = await POST(rawRequest('{not valid json'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32700);
  });
});

// ─── unknown method ───────────────────────────────────────────────────────────

describe('POST /api/mcp — unknown method', () => {
  it('returns code -32601 for an unrecognised method', async () => {
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 99, method: 'no_such_method' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});

// ─── auth ─────────────────────────────────────────────────────────────────────

describe('POST /api/mcp — INFLOOP_API_TOKEN', () => {
  const origToken = process.env.INFLOOP_API_TOKEN;

  afterAll(() => {
    if (origToken === undefined) delete process.env.INFLOOP_API_TOKEN;
    else process.env.INFLOOP_API_TOKEN = origToken;
  });

  it('returns 401 when token is set and Authorization header is missing', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret-test-token';
    const res = await POST(
      mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 when the correct Bearer token is provided', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret-test-token';
    const res = await POST(
      mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { authorization: 'Bearer secret-test-token' },
      ),
    );
    expect(res.status).toBe(200);
  });
});
