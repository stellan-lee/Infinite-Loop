import { afterAll, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import type { HumanDecisionRecord } from '@/lib/shared/workflow';

/*
 * Manual-gate decision API tests.
 *
 * The route is a thin shim over `RunController.submitDecision`; this suite
 * pins its HTTP behavior: error mapping (400 / 404 / 409), the happy-path
 * 200, and the GET endpoint that surfaces parked gates for polling clients.
 */

const realEngine = { ...(await import('@/lib/server/workflow-engine')) };
const realAudit = { ...(await import('@/lib/server/audit-log')) };

mock.module('@/lib/server/workflow-engine', () => ({
  workflowEngine: { getRun: mock() },
}));
mock.module('@/lib/server/audit-log', () => ({
  ...realAudit,
  recordAudit: mock(async () => {}),
}));

const { workflowEngine } = await import('@/lib/server/workflow-engine');
const { GET, POST } = await import('./route');

afterAll(() => {
  mock.module('@/lib/server/workflow-engine', () => realEngine);
  mock.module('@/lib/server/audit-log', () => realAudit);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
const getRunMock = workflowEngine.getRun as unknown as AnyMock;

interface FakeCtrl {
  workflow: { id: string };
  correlationId: string;
  submitDecision: ReturnType<typeof mock>;
  pendingHumanDecisions: ReturnType<typeof mock>;
}

function ctrl(workflowId: string): FakeCtrl {
  return {
    workflow: { id: workflowId },
    correlationId: 'corr-1',
    submitDecision: mock(),
    pendingHumanDecisions: mock(() => []),
  };
}

function postReq(workflowId: string, runId: string, body: unknown) {
  const req = new Request(
    `http://localhost/api/runs/${workflowId}/${runId}/decision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return [req, { params: Promise.resolve({ workflowId, runId }) }] as const;
}

beforeEach(() => {
  getRunMock.mockReset();
});

describe('POST /api/runs/:wf/:run/decision', () => {
  it('returns 400 when nodeId is missing', async () => {
    const c = ctrl('wf');
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', { decision: 'accepted' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/nodeId/);
  });

  it('returns 400 when decision is missing', async () => {
    const c = ctrl('wf');
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', { nodeId: 'manual-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when no live run matches the id', async () => {
    getRunMock.mockReturnValue(undefined);
    const [req, ctx] = postReq('wf', 'rid', { nodeId: 'manual-1', decision: 'accepted' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the run id belongs to a different workflow', async () => {
    const c = ctrl('other-wf');
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', { nodeId: 'manual-1', decision: 'accepted' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('maps run-not-running → 409', async () => {
    const c = ctrl('wf');
    c.submitDecision.mockReturnValue({ ok: false, reason: 'run-not-running' });
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', { nodeId: 'manual-1', decision: 'accepted' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });

  it('maps no-pending-decision → 404', async () => {
    const c = ctrl('wf');
    c.submitDecision.mockReturnValue({ ok: false, reason: 'no-pending-decision' });
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', { nodeId: 'manual-1', decision: 'accepted' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('maps invalid-decision → 400 and echoes allowed keys', async () => {
    const c = ctrl('wf');
    c.submitDecision.mockReturnValue({
      ok: false,
      reason: 'invalid-decision',
      allowed: ['accepted', 'rejected'],
    });
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', { nodeId: 'manual-1', decision: 'maybe' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { allowed: string[] };
    expect(body.allowed).toEqual(['accepted', 'rejected']);
  });

  it('returns 200 with the decision record on success', async () => {
    const c = ctrl('wf');
    const record: HumanDecisionRecord = {
      decision: 'accepted',
      decidedBy: 'open',
      decidedAt: 1730000000000,
      comment: 'lgtm',
    };
    c.submitDecision.mockReturnValue({ ok: true, record });
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', {
      nodeId: 'manual-1',
      decision: 'accepted',
      comment: 'lgtm',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string; comment: string };
    expect(body.decision).toBe('accepted');
    expect(body.comment).toBe('lgtm');
    expect(c.submitDecision).toHaveBeenCalledTimes(1);
  });

  it('rejects non-string comment with 400', async () => {
    const c = ctrl('wf');
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', {
      nodeId: 'manual-1',
      decision: 'accepted',
      comment: 42,
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('rejects an over-long comment with 400 and never calls submitDecision', async () => {
    const c = ctrl('wf');
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', {
      nodeId: 'manual-1',
      decision: 'accepted',
      // 4001 chars — one over the cap.
      comment: 'x'.repeat(4001),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; maxLength?: number };
    expect(body.error).toMatch(/exceeds maximum length/);
    expect(body.maxLength).toBe(4000);
    expect(c.submitDecision).not.toHaveBeenCalled();
  });

  it('accepts a comment at exactly the cap', async () => {
    const c = ctrl('wf');
    c.submitDecision.mockReturnValue({
      ok: true,
      record: {
        decision: 'accepted',
        decidedBy: 'open',
        decidedAt: 1,
        comment: 'x'.repeat(4000),
      },
    });
    getRunMock.mockReturnValue(c);
    const [req, ctx] = postReq('wf', 'rid', {
      nodeId: 'manual-1',
      decision: 'accepted',
      comment: 'x'.repeat(4000),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/runs/:wf/:run/decision', () => {
  function getReq(workflowId: string, runId: string) {
    const req = new Request(
      `http://localhost/api/runs/${workflowId}/${runId}/decision`,
    );
    return [req, { params: Promise.resolve({ workflowId, runId }) }] as const;
  }

  it('returns 404 when no live run matches the id', async () => {
    getRunMock.mockReturnValue(undefined);
    const [req, ctx] = getReq('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('echoes the pending gates from the controller', async () => {
    const c = ctrl('wf');
    c.pendingHumanDecisions.mockReturnValue([
      {
        nodeId: 'manual-1',
        brief: 'review',
        decisions: [{ key: 'accepted' }],
        since: 1730000000000,
      },
    ]);
    getRunMock.mockReturnValue(c);
    const [req, ctx] = getReq('wf', 'rid');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: Array<{ nodeId: string }>;
    };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].nodeId).toBe('manual-1');
  });

  it('returns every parked gate when multiple are pending in parallel', async () => {
    const c = ctrl('wf');
    c.pendingHumanDecisions.mockReturnValue([
      { nodeId: 'manual-a', brief: 'A', decisions: [{ key: 'accepted' }], since: 1 },
      { nodeId: 'manual-b', brief: 'B', decisions: [{ key: 'rejected' }], since: 2 },
    ]);
    getRunMock.mockReturnValue(c);
    const [req, ctx] = getReq('wf', 'rid');
    const res = await GET(req, ctx);
    const body = (await res.json()) as {
      pending: Array<{ nodeId: string }>;
    };
    expect(body.pending.map((g) => g.nodeId).sort()).toEqual([
      'manual-a',
      'manual-b',
    ]);
  });
});
