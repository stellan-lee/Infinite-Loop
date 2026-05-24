import { NextResponse } from 'next/server';
import { describeActor, requireAuth } from '@/lib/server/auth';
import { workflowEngine } from '@/lib/server/workflow-engine';
import { recordAudit } from '@/lib/server/audit-log';
import { createLogger } from '@/lib/server/logger';
import { MANUAL_DECISION_KEYS } from '@/lib/shared/workflow';

const log = createLogger('manual-decision');

/** Hard ceiling on a single reviewer comment. The comment is persisted
 *  verbatim onto the manual node's scope and into the run's event log,
 *  both of which are kept on disk for the life of the run record — so an
 *  uncapped comment field is a cheap way for a misbehaving client to
 *  inflate every persisted record. 4 KiB lets a thorough review note
 *  through (a couple of paragraphs) without unbounded growth. */
const MAX_COMMENT_LENGTH = 4000;

/**
 * Submit a decision for a Manual / human-acceptance gate currently parked
 * inside the given run. The route is the operator-facing complement of the
 * `node_waiting_for_human` event; it accepts the conventional
 * `accepted` / `needs_changes` / `rejected` decisions plus an optional
 * comment, then asks the live `RunController` to resume the gate.
 *
 * Productized: never references any specific reviewer / agent / persona.
 * Auth is the same `requireAuth` gate every API route uses, so a token /
 * session cookie is the authorization model.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ workflowId: string; runId: string }> },
) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { workflowId, runId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body' },
      { status: 400 },
    );
  }

  const obj =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const nodeId = obj.nodeId;
  const decision = obj.decision;
  const comment = obj.comment;

  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return NextResponse.json(
      { error: 'nodeId is required' },
      { status: 400 },
    );
  }
  if (typeof decision !== 'string' || decision.length === 0) {
    return NextResponse.json(
      {
        error: 'decision is required',
        allowed: MANUAL_DECISION_KEYS,
      },
      { status: 400 },
    );
  }
  if (comment !== undefined && typeof comment !== 'string') {
    return NextResponse.json(
      { error: 'comment must be a string when provided' },
      { status: 400 },
    );
  }
  if (typeof comment === 'string' && comment.length > MAX_COMMENT_LENGTH) {
    return NextResponse.json(
      {
        error: `comment exceeds maximum length of ${MAX_COMMENT_LENGTH} characters`,
        maxLength: MAX_COMMENT_LENGTH,
      },
      { status: 400 },
    );
  }

  const ctrl = workflowEngine.getRun(runId);
  if (!ctrl || ctrl.workflow.id !== workflowId) {
    return NextResponse.json(
      { error: `run not found or not active: ${workflowId}/${runId}` },
      { status: 404 },
    );
  }

  const actor = describeActor(req);
  const result = ctrl.submitDecision({
    nodeId,
    decision,
    comment,
    actor,
  });

  if (!result.ok) {
    const status =
      result.reason === 'run-not-running'
        ? 409
        : result.reason === 'no-pending-decision'
          ? 404
          : 400; // invalid-decision / decision-not-allowed
    void recordAudit({
      category: 'run',
      action: 'manual-decision-rejected',
      outcome: 'failure',
      actor,
      target: runId,
      correlationId: ctrl.correlationId,
      detail: {
        workflowId,
        nodeId,
        decision,
        reason: result.reason,
        ...(result.allowed ? { allowed: result.allowed } : {}),
      },
    });
    return NextResponse.json(
      {
        error: result.reason,
        ...(result.allowed ? { allowed: result.allowed } : {}),
      },
      { status },
    );
  }

  void recordAudit({
    category: 'run',
    action: 'manual-decision',
    outcome: 'info',
    actor,
    target: runId,
    correlationId: ctrl.correlationId,
    detail: {
      workflowId,
      nodeId,
      decision: result.record.decision,
      ...(result.record.comment ? { commented: true } : {}),
    },
  });

  log.info('manual decision recorded', {
    correlationId: ctrl.correlationId,
    nodeId,
    decision: result.record.decision,
  });

  return NextResponse.json(
    {
      ok: true,
      decision: result.record.decision,
      decidedBy: result.record.decidedBy,
      decidedAt: result.record.decidedAt,
      ...(result.record.comment ? { comment: result.record.comment } : {}),
    },
    { status: 200 },
  );
}

/**
 * GET surfaces the currently-pending Manual gate(s) on this run, so the UI
 * (or an `at`-like manual reviewer CLI) can render the decision form
 * without subscribing to the SSE stream. Returns an empty array when the
 * run is not parked on any gate (so callers can poll).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ workflowId: string; runId: string }> },
) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { workflowId, runId } = await ctx.params;
  const ctrl = workflowEngine.getRun(runId);
  if (!ctrl || ctrl.workflow.id !== workflowId) {
    return NextResponse.json(
      { error: `run not found or not active: ${workflowId}/${runId}` },
      { status: 404 },
    );
  }
  return NextResponse.json(
    {
      runId,
      workflowId,
      pending: ctrl.pendingHumanDecisions(),
    },
    { status: 200 },
  );
}
