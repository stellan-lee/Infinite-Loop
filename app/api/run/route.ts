import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { workflowEngine } from '@/lib/server/workflow-engine';
import { getWorkflow } from '@/lib/server/workflow-store';
import { engineStartAdapter } from '@/lib/server/trigger-queue-singleton';
import {
  resolveRunInputs,
  WorkflowInputError,
} from '@/lib/shared/resolve-run-inputs';

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
    // Use the same adapter the trigger queue uses — it pre-checks the
    // busy state and assigns runId synchronously, closing the
    // check→start TOCTOU window that the old getState()-then-start
    // pattern left open.
    runId = await engineStartAdapter(workflowEngine, workflow, { resolvedInputs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to start';
    if (/already active/i.test(message)) {
      const currentState = workflowEngine.getState();
      return NextResponse.json(
        {
          error: 'a run is already active',
          runId: currentState.runId,
          workflowId: currentState.workflowId,
        },
        { status: 409 },
      );
    }
    console.error('[api/run] engine.start failed:', err);
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
  return NextResponse.json({ state: workflowEngine.getState() }, { status: 200 });
}
