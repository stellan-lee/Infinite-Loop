import { afterAll, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import type { RunSnapshot } from '@/lib/shared/workflow';

const realEngine = { ...(await import('@/lib/server/workflow-engine')) };
const realStore = { ...(await import('@/lib/server/run-store')) };

mock.module('@/lib/server/workflow-engine', () => ({
  workflowEngine: { getState: mock(), getRun: mock() },
}));
mock.module('@/lib/server/run-store', () => ({
  getRun: mock(),
}));

const { workflowEngine } = await import('@/lib/server/workflow-engine');
const { getRun } = await import('@/lib/server/run-store');
const { GET } = await import('./route');

afterAll(() => {
  mock.module('@/lib/server/workflow-engine', () => realEngine);
  mock.module('@/lib/server/run-store', () => realStore);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
const getStateMock = workflowEngine.getState as unknown as AnyMock;
const getRunMock = getRun as unknown as AnyMock;

function notFound() {
  const err = new Error('not found') as Error & { code?: string };
  err.code = 'ENOENT';
  return err;
}

function reqCtx(workflowId: string, runId: string) {
  const req = new Request(`http://localhost/api/runs/${workflowId}/${runId}`);
  return [req, { params: Promise.resolve({ workflowId, runId }) }] as const;
}

beforeEach(() => {
  getStateMock.mockReset();
  getRunMock.mockReset();
});

describe('GET /api/runs/:workflowId/:runId fall-through', () => {
  it('returns the persisted record when present', async () => {
    getRunMock.mockResolvedValue({ runId: 'rid', workflowId: 'wf', status: 'succeeded' });
    const [req, ctx] = reqCtx('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string } };
    expect(body.run.status).toBe('succeeded');
  });

  it('synthesises a running record from engine snapshot when not persisted yet', async () => {
    getRunMock.mockRejectedValue(notFound());
    const snap: RunSnapshot = {
      status: 'running',
      runId: 'rid',
      workflowId: 'wf',
      iterationByLoopId: { 'loop-1': 2 },
      scope: { 'claude-1': { stdout: 'partial' } },
      startedAt: 1000,
      currentNodeId: 'claude-1',
    };
    getStateMock.mockReturnValue(snap);

    const [req, ctx] = reqCtx('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { status: string; currentNodeId?: string; iterationByLoopId?: Record<string, number> };
    };
    expect(body.run.status).toBe('running');
    expect(body.run.currentNodeId).toBe('claude-1');
    expect(body.run.iterationByLoopId).toEqual({ 'loop-1': 2 });
  });

  it('synthesises a terminal record from engine snapshot during the persist gap', async () => {
    getRunMock.mockRejectedValue(notFound());
    getStateMock.mockReturnValue({
      status: 'succeeded',
      runId: 'rid',
      workflowId: 'wf',
      iterationByLoopId: {},
      scope: { 'end-1': { outcome: 'succeeded' } },
      startedAt: 1000,
      finishedAt: 1500,
    });
    const [req, ctx] = reqCtx('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string; finishedAt?: number } };
    expect(body.run.status).toBe('succeeded');
    expect(body.run.finishedAt).toBe(1500);
  });

  it('404s when neither persisted nor matching engine snapshot', async () => {
    getRunMock.mockRejectedValue(notFound());
    getStateMock.mockReturnValue({
      status: 'idle',
      iterationByLoopId: {},
      scope: {},
    });
    const [req, ctx] = reqCtx('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('404s when the engine snapshot is for a different run', async () => {
    getRunMock.mockRejectedValue(notFound());
    getStateMock.mockReturnValue({
      status: 'running',
      runId: 'other-rid',
      workflowId: 'wf',
      iterationByLoopId: {},
      scope: {},
      startedAt: 1,
    });
    const [req, ctx] = reqCtx('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('reports status=waiting_for_human and surfaces every pending gate when one or more human gates are parked', async () => {
    getRunMock.mockRejectedValue(notFound());
    const snap: RunSnapshot = {
      status: 'running',
      runId: 'rid',
      workflowId: 'wf',
      iterationByLoopId: {},
      scope: {},
      startedAt: 1,
      // The single-slot waitingFor mirror points at one gate; the
      // canonical list lives on the controller.
      waitingFor: {
        kind: 'human',
        nodeId: 'manual-a',
        brief: 'A',
        decisions: [{ key: 'accepted' }],
        since: 1,
      },
    };
    const fakeCtrl = {
      getState: () => snap,
      pendingHumanDecisions: () => [
        { nodeId: 'manual-a', brief: 'A', decisions: [{ key: 'accepted' }], since: 1 },
        { nodeId: 'manual-b', brief: 'B', decisions: [{ key: 'rejected' }], since: 2 },
      ],
      workflow: { id: 'wf' },
      correlationId: 'corr',
      runId: 'rid',
    };
    (workflowEngine.getRun as unknown as AnyMock).mockReturnValue(fakeCtrl);

    const [req, ctx] = reqCtx('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        status: string;
        pendingHumanDecisions?: Array<{ nodeId: string }>;
      };
    };
    expect(body.run.status).toBe('waiting_for_human');
    expect(body.run.pendingHumanDecisions?.map((g) => g.nodeId).sort()).toEqual([
      'manual-a',
      'manual-b',
    ]);
  });
});
