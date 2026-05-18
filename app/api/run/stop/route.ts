import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { workflowEngine } from '@/lib/server/workflow-engine';

/**
 * Stop semantics:
 *   POST /api/run/stop?runId=<id>  — stop one run
 *   POST /api/run/stop?all=1       — stop every currently-alive run
 *   POST /api/run/stop             — back-compat: stop every alive run
 *
 * Per design doc B7: stopping does NOT clear the trigger queue. Queued
 * webhook/schedule items continue to drain; to clear them use the trigger
 * endpoints.
 */
export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const runId = url.searchParams.get('runId') ?? undefined;
  const all = url.searchParams.get('all') === '1';

  if (runId && all) {
    return NextResponse.json(
      { error: '?runId and ?all=1 are mutually exclusive' },
      { status: 400 },
    );
  }

  if (runId) {
    // Single-run stop. Reject if the run is not currently in flight —
    // calling stop on a settled controller is a no-op and would otherwise
    // return 200 misleadingly.
    const ctrl = workflowEngine.getRun(runId);
    if (!ctrl || ctrl.snapshot.status !== 'running') {
      return NextResponse.json(
        { error: `run not active: ${runId}` },
        { status: 404 },
      );
    }
    workflowEngine.stop(runId);
  } else {
    // ?all=1 or no params: stop every alive run. Per design doc, this does
    // NOT clear the trigger queue.
    workflowEngine.stop();
  }

  return NextResponse.json(
    {
      state: workflowEngine.getState(),
      activeRuns: workflowEngine.list().map((c) => c.runId),
    },
    { status: 200 },
  );
}
