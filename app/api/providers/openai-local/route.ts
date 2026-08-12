import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  createOpenAiConnection,
  isValidOpenAiLocalId,
  listOpenAiConnections,
  type OpenAiLocalInput,
} from '@/lib/server/providers/openai-local-store';

export async function GET(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  try {
    return NextResponse.json({ connections: await listOpenAiConnections() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed to list providers' }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'request body must be JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'request body must be a JSON object' }, { status: 400 });
  const rawId = typeof (body as Record<string, unknown>).id === 'string' ? (body as Record<string, unknown>).id as string : '';
  if (rawId && !isValidOpenAiLocalId(rawId)) return NextResponse.json({ error: 'id must match /^[a-z0-9][a-z0-9-]{0,29}$/' }, { status: 400 });
  try {
    return NextResponse.json({ connection: await createOpenAiConnection(rawId || null, body as OpenAiLocalInput) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to create provider';
    return NextResponse.json({ error: message }, { status: message.includes('already exists') ? 409 : 400 });
  }
}
