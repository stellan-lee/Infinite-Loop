import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { getRun } from '@/lib/server/run-store';
import { isNotFoundError } from '@/app/api/workflows/validate';
import { workflowEngine } from '@/lib/server/workflow-engine';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ workflowId: string; runId: string }> },
) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { workflowId, runId } = await ctx.params;

  try {
    const run = await getRun(workflowId, runId);
    return NextResponse.json({ run }, { status: 200 });
  } catch (err) {
    if (!isNotFoundError(err)) {
      const message = err instanceof Error ? err.message : 'load failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }
    // Fall through to engine snapshot.
  }

  // Multi-run aware lookup: check the registry by runId first; fall back
  // to the engine's last-snapshot for back-compat with the single-run
  // callers that don't carry a registry-aware runId yet.
  const ctrl = workflowEngine.getRun(runId);
  const snap = ctrl ? ctrl.getState() : workflowEngine.getState();
  if (snap.runId === runId && snap.workflowId === workflowId) {
    const synthetic = {
      runId,
      workflowId,
      status: snap.status,
      startedAt: snap.startedAt,
      finishedAt: snap.finishedAt,
      errorMessage: snap.errorMessage,
      currentNodeId: snap.currentNodeId,
      iterationByLoopId: snap.iterationByLoopId,
      // Partial scope while running; full on settle. A polling caller wants
      // to see node outputs as they land.
      scope: snap.scope,
      // events intentionally omitted — the SSE bus at /api/events is the
      // canonical live event stream; this endpoint is a snapshot view.
    };
    return NextResponse.json({ run: synthetic }, { status: 200 });
  }

  return NextResponse.json({ error: 'run not found' }, { status: 404 });
}
