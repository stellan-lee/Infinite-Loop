import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import {
  getTrigger,
  TriggerNotFoundError,
} from '@/lib/server/trigger-store';
import { POST as webhookPOST } from '@/app/api/webhook/[triggerId]/route';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Same cap the public webhook route applies. The webhook route enforces
 *  this via `Content-Length` before reading the body, but our synthetic
 *  Request bypasses that path — so we cap here too. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  // Honor the incoming Content-Length cap before reading any body —
  // mirrors the public /api/webhook/[triggerId] guard so a callers can't
  // use the test route to push past the size limit.
  const lenHeader = req.headers.get('content-length');
  if (lenHeader) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ error: 'payload-too-large' }, { status: 413 });
    }
  }
  const { id } = await params;
  try {
    await getTrigger(id);
  } catch (err) {
    if (err instanceof TriggerNotFoundError) {
      return NextResponse.json({ error: 'not-found' }, { status: 404 });
    }
    throw err;
  }

  let body: { payload?: unknown; headers?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const payloadJson = JSON.stringify(body.payload ?? {});
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: 'payload-too-large' }, { status: 413 });
  }
  // Caller-supplied headers come first so we own the final values of
  // content-type / content-length — these must not be overridable from
  // the request body, otherwise the synthesized request can lie about
  // its size and bypass the webhook route's body-cap re-check.
  const headers: Record<string, string> = {
    ...(body.headers ?? {}),
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payloadJson, 'utf8')),
  };

  const synthetic = new Request(`http://test/api/webhook/${id}`, {
    method: 'POST',
    headers,
    body: payloadJson,
  });
  const result = await webhookPOST(synthetic, {
    params: Promise.resolve({ triggerId: id }),
  });
  // Read the response so we can return it in a structured envelope.
  let responseBody: unknown = null;
  const text = await result.text();
  if (text.length > 0) {
    try { responseBody = JSON.parse(text); }
    catch { responseBody = text; }
  }
  return NextResponse.json({
    status: result.status,
    body: responseBody,
  });
}
