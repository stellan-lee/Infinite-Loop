import { afterAll, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import type { Workflow, WorkflowSummary } from '@/lib/shared/workflow';

// Snapshot the real exports before mocking so afterAll can re-publish a
// value-equivalent module (Bun has no true unmock; mock.module is keyed by
// specifier and persists for the rest of the test process).
const realStore = { ...(await import('@/lib/server/workflow-store')) };

mock.module('@/lib/server/workflow-store', () => ({
  listWorkflows: mock(),
  getWorkflow: mock(),
  saveWorkflow: mock(),
  deleteWorkflow: mock(),
}));

import * as store from '@/lib/server/workflow-store';
import { GET as listGET, POST as listPOST } from './route';
import {
  GET as itemGET,
  PUT as itemPUT,
  DELETE as itemDELETE,
} from './[id]/route';

afterAll(() => {
  mock.module('@/lib/server/workflow-store', () => realStore);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
const mocked = store as unknown as {
  listWorkflows: AnyMock;
  getWorkflow: AnyMock;
  saveWorkflow: AnyMock;
  deleteWorkflow: AnyMock;
};

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    version: 1,
    nodes: [],
    edges: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request('http://localhost/api/workflows', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function paramsCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mocked.listWorkflows.mockReset();
  mocked.getWorkflow.mockReset();
  mocked.saveWorkflow.mockReset();
  mocked.deleteWorkflow.mockReset();
});

describe('GET /api/workflows', () => {
  it('returns 200 with workflows from listWorkflows', async () => {
    const summaries: WorkflowSummary[] = [
      { id: 'wf-1', name: 'A', version: 1, updatedAt: 1 },
      { id: 'wf-2', name: 'B', version: 2, updatedAt: 2 },
    ];
    mocked.listWorkflows.mockResolvedValueOnce(summaries);

    const res = await listGET(new Request('http://test/api/workflows'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ workflows: summaries });
    expect(mocked.listWorkflows).toHaveBeenCalledTimes(1);
  });

  it('returns 500 on store error', async () => {
    mocked.listWorkflows.mockRejectedValueOnce(new Error('disk on fire'));
    const res = await listGET(new Request('http://test/api/workflows'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('disk on fire');
  });
});

describe('POST /api/workflows', () => {
  it('returns 201 and calls saveWorkflow with the body', async () => {
    const wf = makeWorkflow();
    mocked.saveWorkflow.mockResolvedValueOnce(wf);

    const res = await listPOST(jsonRequest('POST', wf));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ workflow: wf });
    expect(mocked.saveWorkflow).toHaveBeenCalledWith(wf);
  });

  it('returns 400 when nodes is missing', async () => {
    const bad = { id: 'wf-1', name: 'x', edges: [] };
    const res = await listPOST(jsonRequest('POST', bad));
    expect(res.status).toBe(400);
    expect(mocked.saveWorkflow).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    const req = new Request('http://localhost/api/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await listPOST(req);
    expect(res.status).toBe(400);
  });

  it('returns 500 when saveWorkflow throws', async () => {
    mocked.saveWorkflow.mockRejectedValueOnce(new Error('store boom'));
    const res = await listPOST(jsonRequest('POST', makeWorkflow()));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/workflows/[id]', () => {
  it('returns 200 with the workflow', async () => {
    const wf = makeWorkflow({ id: 'abc' });
    mocked.getWorkflow.mockResolvedValueOnce(wf);

    const res = await itemGET(new Request('http://localhost/api/workflows/abc'), paramsCtx('abc'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ workflow: wf });
    expect(mocked.getWorkflow).toHaveBeenCalledWith('abc');
  });

  it('returns 404 when getWorkflow throws not-found', async () => {
    mocked.getWorkflow.mockRejectedValueOnce(new Error('workflow xyz not found'));
    const res = await itemGET(new Request('http://localhost/api/workflows/xyz'), paramsCtx('xyz'));
    expect(res.status).toBe(404);
  });

  it('returns 500 on other errors', async () => {
    mocked.getWorkflow.mockRejectedValueOnce(new Error('disk read failed'));
    const res = await itemGET(new Request('http://localhost/api/workflows/xyz'), paramsCtx('xyz'));
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/workflows/[id]', () => {
  it('returns 400 on id mismatch', async () => {
    const wf = makeWorkflow({ id: 'wf-1' });
    const res = await itemPUT(jsonRequest('PUT', wf), paramsCtx('different-id'));
    expect(res.status).toBe(400);
    expect(mocked.saveWorkflow).not.toHaveBeenCalled();
  });

  it('returns 200 with the saved workflow', async () => {
    const wf = makeWorkflow({ id: 'wf-1', name: 'updated' });
    mocked.saveWorkflow.mockResolvedValueOnce(wf);

    const res = await itemPUT(jsonRequest('PUT', wf), paramsCtx('wf-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ workflow: wf });
    expect(mocked.saveWorkflow).toHaveBeenCalledWith(wf);
  });

  it('returns 400 when body shape is invalid', async () => {
    const res = await itemPUT(jsonRequest('PUT', { id: 'wf-1', name: 'x' }), paramsCtx('wf-1'));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/workflows/[id]', () => {
  it('returns 204 with empty body on success', async () => {
    mocked.deleteWorkflow.mockResolvedValueOnce(undefined);

    const res = await itemDELETE(new Request('http://localhost/api/workflows/wf-1', { method: 'DELETE' }), paramsCtx('wf-1'));
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
    expect(mocked.deleteWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('returns 404 when delete reports not-found', async () => {
    mocked.deleteWorkflow.mockRejectedValueOnce(new Error('not found: wf-missing'));
    const res = await itemDELETE(new Request('http://localhost/api/workflows/wf-missing', { method: 'DELETE' }), paramsCtx('wf-missing'));
    expect(res.status).toBe(404);
  });
});
