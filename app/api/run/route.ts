import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { workflowEngine } from '@/lib/server/workflow-engine';
import { getWorkflow } from '@/lib/server/workflow-store';
import { engineStartAdapter } from '@/lib/server/trigger-queue-singleton';
import {
  resolveRunInputs,
  WorkflowInputError,
} from '@/lib/shared/resolve-run-inputs';
import { createLogger } from '@/lib/server/logger';

const log = createLogger('run');

export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const obj = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const workflowId = obj.workflowId;
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    return NextResponse.json(
      { error: 'workflowId is required' },
      { status: 400 },
    );
  }

  const suppliedInputs =
    obj.inputs && typeof obj.inputs === 'object' && !Array.isArray(obj.inputs)
      ? (obj.inputs as Record<string, unknown>)
      : {};

  let workflow;
  try {
    workflow = await getWorkflow(workflowId);
  } catch {
    return NextResponse.json(
      { error: `workflow not found: ${workflowId}` },
      { status: 404 },
    );
  }

  let resolvedInputs;
  try {
    resolvedInputs = resolveRunInputs(workflow.inputs ?? [], suppliedInputs);
  } catch (err) {
    if (err instanceof WorkflowInputError) {
      return NextResponse.json(
        {
          error: 'invalid-inputs',
          field: err.field,
          reason: err.reason,
          ...(err.expected ? { expected: err.expected } : {}),
          ...(err.got ? { got: err.got } : {}),
        },
        { status: 400 },
      );
    }
    throw err;
  }

  let runId: string;
  try {
    // Multi-run safe: returns the runId synchronously regardless of how
    // many runs are already in flight. Folder-touching runs are throttled
    // inside the controller's first lock acquire → slot pool wait.
    runId = await engineStartAdapter(workflowEngine, workflow, { resolvedInputs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to start';
    // A run refused because the process-wide cost budget is exhausted is not a
    // server fault — answer 503 (try again once the budget is raised/reset),
    // not 500. See lib/server/cost-budget.ts.
    if ((err as { code?: string } | null)?.code === 'COST_BUDGET_EXCEEDED') {
      log.warn('run refused: process-wide cost budget exceeded');
      return NextResponse.json({ error: message }, { status: 503 });
    }
    log.error('engine.start failed', { err });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json(
    {
      runId,
      state: workflowEngine.getState(),
    },
    { status: 202 },
  );
}

export async function GET(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const runs = workflowEngine.list().map((c) => ({
    runId: c.runId,
    workflowId: c.workflow.id,
    workflowName: c.workflow.name,
    status: c.snapshot.status,
    startedAt: c.snapshot.startedAt,
    waitingFor: c.snapshot.waitingFor,
  }));
  return NextResponse.json(
    {
      state: workflowEngine.getState(),
      runs,
      slotPool: {
        capacity: workflowEngine.slotPool.getCapacity(),
        size: workflowEngine.slotPool.size(),
        waiters: workflowEngine.slotPool.waiterCount(),
      },
    },
    { status: 200 },
  );
}
