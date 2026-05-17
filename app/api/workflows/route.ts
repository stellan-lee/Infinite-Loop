import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  listWorkflows,
  saveWorkflow,
} from '@/lib/server/workflow-store';
import { hasBasicWorkflowShape } from './validate';

export async function GET(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  try {
    const workflows = await listWorkflows();
    return NextResponse.json({ workflows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list workflows' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!hasBasicWorkflowShape(body)) {
    return NextResponse.json(
      { error: 'invalid workflow: id, name, nodes, edges are required' },
      { status: 400 },
    );
  }

  try {
    const workflow = await saveWorkflow(body);
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to save workflow' },
      { status: 500 },
    );
  }
}
