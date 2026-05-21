import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  createConnection,
  isValidLocalId,
  listConnections,
  type HermesLocalInput,
} from '@/lib/server/providers/hermes-local-store';

export async function GET(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  try {
    const connections = await listConnections();
    return NextResponse.json({ connections });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list connections' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'request body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'request body must be a JSON object' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  // `id` is optional now — when omitted, the store derives a unique slug
  // from `label`. We still accept an explicit id for power users / scripted
  // requests; reject it early if obviously malformed.
  const rawId = typeof b.id === 'string' ? b.id : '';
  if (rawId.length > 0 && !isValidLocalId(rawId)) {
    return NextResponse.json(
      { error: 'id must match /^[a-z0-9][a-z0-9-]{0,29}$/' },
      { status: 400 },
    );
  }
  try {
    const connection = await createConnection(
      rawId.length > 0 ? rawId : null,
      b as HermesLocalInput,
    );
    return NextResponse.json({ connection }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to create connection';
    // The store throws "already exists" with that exact prefix; surface it
    // as a 409 instead of a generic 400 so the UI can show a focused error.
    const status = message.startsWith('a connection with id') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
