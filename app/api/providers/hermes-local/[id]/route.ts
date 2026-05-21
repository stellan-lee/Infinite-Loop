import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  deleteConnection,
  getConnection,
  isValidLocalId,
  updateConnection,
  type HermesLocalInput,
} from '@/lib/server/providers/hermes-local-store';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await params;
  if (!isValidLocalId(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const connection = await getConnection(id);
  if (!connection) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ connection });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await params;
  if (!isValidLocalId(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'request body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'request body must be a JSON object' }, { status: 400 });
  }
  try {
    const connection = await updateConnection(id, body as HermesLocalInput);
    if (!connection) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ connection });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to update connection' },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await params;
  if (!isValidLocalId(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const deleted = await deleteConnection(id);
  if (!deleted) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
