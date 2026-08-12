import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  deleteOpenAiConnection,
  getOpenAiConnection,
  isValidOpenAiLocalId,
  updateOpenAiConnection,
  type OpenAiLocalInput,
} from '@/lib/server/providers/openai-local-store';

async function idFor(params: Promise<{ id: string }>): Promise<string | null> {
  const { id } = await params;
  return isValidOpenAiLocalId(id) ? id : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const id = await idFor(params);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const connection = await getOpenAiConnection(id);
  return connection ? NextResponse.json({ connection }) : NextResponse.json({ error: 'not found' }, { status: 404 });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const id = await idFor(params);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'request body must be JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'request body must be a JSON object' }, { status: 400 });
  try {
    const connection = await updateOpenAiConnection(id, body as OpenAiLocalInput);
    return connection ? NextResponse.json({ connection }) : NextResponse.json({ error: 'not found' }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed to update provider' }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const id = await idFor(params);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  return (await deleteOpenAiConnection(id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'not found' }, { status: 404 });
}
