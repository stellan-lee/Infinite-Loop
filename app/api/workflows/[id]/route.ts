import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  deleteWorkflow,
  getWorkflow,
  saveWorkflow,
} from '@/lib/server/workflow-store';
import { hasBasicWorkflowShape, isNotFoundError } from '../validate';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await ctx.params;
  try {
    const workflow = await getWorkflow(id);
    return NextResponse.json({ workflow });
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'workflow not found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to load workflow' },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await ctx.params;

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

  if (body.id !== id) {
    return NextResponse.json(
      { error: 'workflow id in body does not match url' },
      { status: 400 },
    );
  }

  try {
    const workflow = await saveWorkflow(body);
    return NextResponse.json({ workflow });
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'workflow not found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to save workflow' },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await ctx.params;
  try {
    await deleteWorkflow(id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'workflow not found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to delete workflow' },
      { status: 500 },
    );
  }
}
