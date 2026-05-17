import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Workflow } from '@/lib/shared/workflow';

const realStore = { ...(await import('@/lib/server/workflow-store')) };
const realQueue = { ...(await import('@/lib/server/trigger-queue-singleton')) };

mock.module('@/lib/server/workflow-store', () => ({
  getWorkflow: mock(),
}));
mock.module('@/lib/server/trigger-queue-singleton', () => ({
  triggerQueue: { enqueue: mock(), drain: mock(() => Promise.resolve()) },
}));

const { getWorkflow } = await import('@/lib/server/workflow-store');
const { triggerQueue } = await import('@/lib/server/trigger-queue-singleton');
const { enqueueWorkflowTool } = await import('./enqueue-tool');

afterAll(() => {
  mock.module('@/lib/server/workflow-store', () => realStore);
  mock.module('@/lib/server/trigger-queue-singleton', () => realQueue);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof mock<(...args: any[]) => any>>;
const getWorkflowMock = getWorkflow as unknown as AnyMock;
const enqueueMock = triggerQueue.enqueue as unknown as AnyMock;
const drainMock = triggerQueue.drain as unknown as AnyMock;

const wf: Workflow = {
  id: 'wf-sample',
  name: 'Sample',
  version: 1,
  nodes: [],
  edges: [],
  inputs: [
    { name: 'topic', type: 'string' },
    { name: 'count', type: 'number', default: 1 },
  ],
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  getWorkflowMock.mockReset();
  enqueueMock.mockReset();
  drainMock.mockReset();
  drainMock.mockImplementation(() => Promise.resolve());
});

describe('enqueueWorkflowTool', () => {
  it('returns error when workflow is missing', async () => {
    getWorkflowMock.mockRejectedValue(new Error('not found'));
    const out = await enqueueWorkflowTool({ workflowId: 'wf-x', inputs: {} });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.error).toMatch(/not found/i);
    }
  });

  it('returns error for invalid inputs', async () => {
    getWorkflowMock.mockResolvedValue(wf);
    const out = await enqueueWorkflowTool({ workflowId: 'wf-sample', inputs: {} });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.error).toMatch(/topic/i);
    }
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('enqueues and returns queueId/position on success', async () => {
    getWorkflowMock.mockResolvedValue(wf);
    enqueueMock.mockReturnValue({ queueId: 'q-1', position: 1 });
    const out = await enqueueWorkflowTool({
      workflowId: 'wf-sample',
      inputs: { topic: 'hello' },
    });
    expect(out.status).toBe('queued');
    if (out.status === 'queued') {
      expect(out.queueId).toBe('q-1');
      expect(out.position).toBe(1);
      expect(out.workflowId).toBe('wf-sample');
      expect(out.triggerId).toMatch(/^mcp-/);
      // The id must satisfy the global TRIGGER_ID_RE so downstream lookups
      // accept it — guard against re-introducing the prior format.
      expect(out.triggerId).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    }
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = enqueueMock.mock.calls[0]![0];
    expect(call.workflow.id).toBe('wf-sample');
    expect(call.resolvedInputs).toEqual({ topic: 'hello', count: 1 });
    expect(drainMock).toHaveBeenCalledTimes(1);
  });

  it('returns error when queue is full', async () => {
    getWorkflowMock.mockResolvedValue(wf);
    const err = Object.assign(new Error('full'), { code: 'QUEUE_FULL' });
    enqueueMock.mockImplementation(() => {
      throw err;
    });
    const out = await enqueueWorkflowTool({
      workflowId: 'wf-sample',
      inputs: { topic: 't' },
    });
    expect(out.status).toBe('error');
    if (out.status === 'error') {
      expect(out.error).toMatch(/queue is full/i);
    }
    expect(drainMock).not.toHaveBeenCalled();
  });
});
