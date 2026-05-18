import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RunSummary } from '@/lib/shared/workflow';

// Capture originals before mocking so afterAll can restore.
const realRunStore = { ...(await import('@/lib/server/run-store')) };
const realEngine = { ...(await import('@/lib/server/workflow-engine')) };
const realQueue = { ...(await import('@/lib/server/trigger-queue-singleton')) };
const realHistory = { ...(await import('@/lib/server/queue-history')) };

mock.module('@/lib/server/run-store', () => ({
  getRun: mock(),
  listRuns: mock(),
}));
mock.module('@/lib/server/workflow-engine', () => ({
  workflowEngine: {
    getState: mock(),
    stop: mock(),
    getRun: mock(),
    list: mock(() => []),
  },
}));
mock.module('@/lib/server/trigger-queue-singleton', () => ({
  triggerQueue: { list: mock(), removeByQueueId: mock() },
}));
mock.module('@/lib/server/queue-history', () => ({
  queueHistory: { get: mock() },
}));

const { getRun, listRuns: storeListRuns } = await import('@/lib/server/run-store');
const { workflowEngine } = await import('@/lib/server/workflow-engine');
const { triggerQueue } = await import('@/lib/server/trigger-queue-singleton');
const { queueHistory } = await import('@/lib/server/queue-history');
const {
  getRunStatus,
  listRuns,
  cancelRun,
  listQueue,
  removeFromQueue,
} = await import('./utility-tools');

afterAll(() => {
  mock.module('@/lib/server/run-store', () => realRunStore);
  mock.module('@/lib/server/workflow-engine', () => realEngine);
  mock.module('@/lib/server/trigger-queue-singleton', () => realQueue);
  mock.module('@/lib/server/queue-history', () => realHistory);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof mock<(...args: any[]) => any>>;
const getRunMock = getRun as unknown as AnyMock;
const storeListRunsMock = storeListRuns as unknown as AnyMock;
const getStateMock = workflowEngine.getState as unknown as AnyMock;
const stopMock = workflowEngine.stop as unknown as AnyMock;
const queueListMock = triggerQueue.list as unknown as AnyMock;
const queueRemoveMock = triggerQueue.removeByQueueId as unknown as AnyMock;
const historyGetMock = queueHistory.get as unknown as AnyMock;

const settledRun = {
  runId: 'r',
  workflowId: 'wf',
  workflowName: 'WF',
  status: 'succeeded' as const,
  startedAt: 1000,
  finishedAt: 2000,
  durationMs: 1000,
  scope: { inputs: { hidden: 1 }, 'node-1': { result: 'ok' } },
  events: [],
};

beforeEach(() => {
  getRunMock.mockReset();
  storeListRunsMock.mockReset();
  getStateMock.mockReset();
  stopMock.mockReset();
  queueListMock.mockReset();
  queueRemoveMock.mockReset();
  historyGetMock.mockReset();
});

describe('getRunStatus', () => {
  it('returns filtered outputs from the persisted store', async () => {
    getRunMock.mockResolvedValue(settledRun);
    const out = await getRunStatus({ workflowId: 'wf', runId: 'r' });
    expect(out.status).toBe('succeeded');
    expect(out.runId).toBe('r');
    expect(out.durationMs).toBe(1000);
    expect(out.outputs).toEqual({ 'node-1': { result: 'ok' } });
  });

  it('falls through to engine snapshot when not persisted', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    getRunMock.mockRejectedValue(err);
    getStateMock.mockReturnValue({
      status: 'running',
      runId: 'r',
      workflowId: 'wf',
      iterationByLoopId: {},
      scope: { 'node-1': { partial: true } },
      startedAt: 1000,
    });
    const out = await getRunStatus({ workflowId: 'wf', runId: 'r' });
    expect(out.status).toBe('running');
    expect(out.outputs).toEqual({ 'node-1': { partial: true } });
  });

  it('returns error when neither persisted nor in engine', async () => {
    getRunMock.mockRejectedValue(new Error('not found'));
    getStateMock.mockReturnValue({
      status: 'idle',
      iterationByLoopId: {},
      scope: {},
    });
    const out = await getRunStatus({ workflowId: 'wf', runId: 'r' });
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/not found/i);
  });

  it('returns error when neither runId nor queueId is given', async () => {
    const out = await getRunStatus({});
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/runId.*queueId/i);
  });

  describe('queueId path', () => {
    it('returns error for unknown queueId', async () => {
      historyGetMock.mockReturnValue(undefined);
      const out = await getRunStatus({ queueId: 'q-1' });
      expect(out.status).toBe('error');
      expect(out.error).toMatch(/not found/i);
    });

    it('returns queued state with position when still in queue', async () => {
      historyGetMock.mockReturnValue({
        queueId: 'q-1',
        triggerId: 't',
        workflowId: 'wf',
        state: 'queued',
        enqueuedAt: 1,
        updatedAt: 1,
      });
      queueListMock.mockReturnValue([
        { queueId: 'q-other', triggerId: 't0', workflow: { id: 'wf', name: 'WF' }, receivedAt: 0 },
        { queueId: 'q-1', triggerId: 't', workflow: { id: 'wf', name: 'WF' }, receivedAt: 1 },
      ]);
      const out = await getRunStatus({ queueId: 'q-1' });
      expect(out.status).toBe('queued');
      expect(out.queueId).toBe('q-1');
      expect(out.position).toBe(2);
    });

    it('returns removed state with reason', async () => {
      historyGetMock.mockReturnValue({
        queueId: 'q-1',
        triggerId: 't',
        workflowId: 'wf',
        state: 'removed',
        reason: 'user-cancelled',
        enqueuedAt: 1,
        updatedAt: 2,
      });
      const out = await getRunStatus({ queueId: 'q-1' });
      expect(out.status).toBe('removed');
      expect(out.reason).toBe('user-cancelled');
    });

    it('resolves to run lookup once started', async () => {
      historyGetMock.mockReturnValue({
        queueId: 'q-1',
        triggerId: 't',
        workflowId: 'wf',
        state: 'started',
        runId: 'r',
        enqueuedAt: 1,
        updatedAt: 2,
      });
      getRunMock.mockResolvedValue(settledRun);
      const out = await getRunStatus({ queueId: 'q-1' });
      expect(out.status).toBe('succeeded');
      expect(out.runId).toBe('r');
      expect(out.queueId).toBe('q-1');
      expect(out.outputs).toEqual({ 'node-1': { result: 'ok' } });
    });
  });
});

describe('listRuns', () => {
  it('returns runs from the store', async () => {
    const summaries: RunSummary[] = [
      {
        runId: 'r1',
        workflowId: 'wf',
        workflowName: 'WF',
        status: 'succeeded',
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        eventCount: 0,
      },
    ];
    storeListRunsMock.mockResolvedValue(summaries);
    const out = await listRuns({ workflowId: 'wf' });
    expect(out.runs.length).toBe(1);
    expect(storeListRunsMock).toHaveBeenCalledWith('wf');
  });

  it('passes undefined workflowId for global listing', async () => {
    storeListRunsMock.mockResolvedValue([]);
    await listRuns({});
    expect(storeListRunsMock).toHaveBeenCalledWith(undefined);
  });
});

describe('cancelRun', () => {
  // Stage 5: cancelRun is now multi-run aware. It looks up the controller
  // by runId via engine.getRun(runId) and stops via engine.stop(runId).
  const getRunCtrlMock = (workflowEngine as unknown as { getRun: AnyMock }).getRun;

  it('cancels when a matching run is alive', async () => {
    getRunCtrlMock.mockReturnValue({
      runId: 'r',
      snapshot: { status: 'running', runId: 'r', workflowId: 'wf', iterationByLoopId: {}, scope: {}, startedAt: 1 },
    });
    const out = await cancelRun({ workflowId: 'wf', runId: 'r' });
    expect(out.cancelled).toBe(true);
    expect(stopMock).toHaveBeenCalledWith('r');
  });

  it('returns cancelled:false when run is not active', async () => {
    getRunCtrlMock.mockReturnValue(undefined);
    const out = await cancelRun({ workflowId: 'wf', runId: 'r' });
    expect(out.cancelled).toBe(false);
    expect(out.reason).toMatch(/not active/i);
  });

  it('returns cancelled:false when the matching controller is already settled', async () => {
    getRunCtrlMock.mockReturnValue({
      runId: 'r',
      snapshot: { status: 'succeeded', runId: 'r', workflowId: 'wf', iterationByLoopId: {}, scope: {} },
    });
    const out = await cancelRun({ workflowId: 'wf', runId: 'r' });
    expect(out.cancelled).toBe(false);
    expect(out.reason).toMatch(/not active/i);
  });
});

describe('listQueue', () => {
  it('returns size and items shaped for MCP output', () => {
    queueListMock.mockReturnValue([
      {
        queueId: 'q-1',
        triggerId: 't1',
        workflow: { id: 'wf-a', name: 'Workflow A' },
        receivedAt: 100,
      },
      {
        queueId: 'q-2',
        triggerId: 't2',
        workflow: { id: 'wf-b', name: 'Workflow B' },
        receivedAt: 200,
      },
    ]);
    const out = listQueue();
    expect(out.size).toBe(2);
    expect(out.items[0]).toEqual({
      queueId: 'q-1',
      triggerId: 't1',
      workflowId: 'wf-a',
      workflowName: 'Workflow A',
      receivedAt: 100,
      position: 1,
    });
    expect(out.items[1]!.position).toBe(2);
  });

  it('returns empty list when queue is empty', () => {
    queueListMock.mockReturnValue([]);
    const out = listQueue();
    expect(out.size).toBe(0);
    expect(out.items).toEqual([]);
  });
});

describe('removeFromQueue', () => {
  it('returns removed:true on success', () => {
    queueRemoveMock.mockReturnValue({ removed: true });
    const out = removeFromQueue({ queueId: 'q-1' });
    expect(out.removed).toBe(true);
    expect(queueRemoveMock).toHaveBeenCalledWith('q-1');
  });

  it('returns removed:false with reason when item is gone', () => {
    queueRemoveMock.mockReturnValue({ removed: false });
    const out = removeFromQueue({ queueId: 'q-1' });
    expect(out.removed).toBe(false);
    expect(out.reason).toBe('not-in-queue');
  });
});
