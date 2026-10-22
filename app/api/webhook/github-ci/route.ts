import { verifySignature } from '@/lib/server/webhook-signature';
import { githubCIService } from '@/lib/server/github-ci-service';

const MAX_BODY_BYTES = 2_000_000;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.INFLOOP_GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'GitHub webhook signing is not configured' }, { status: 503 });
  }
  // Limit the stream itself: an unsigned/chunked body must not allocate
  // unbounded memory before signature verification.
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload too large' }, { status: 413 });
  }
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return Response.json({ error: 'payload too large' }, { status: 413 });
        }
        chunks.push(value);
      }
    }
  } catch {
    return Response.json({ error: 'invalid request body' }, { status: 400 });
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const signature = verifySignature({
    scheme: 'hmac-sha256', format: 'sha256=<hex>', secret,
    bodyText: body, headerValue: req.headers.get('x-hub-signature-256'),
  });
  if (!signature.ok) {
    return Response.json({ error: 'invalid GitHub signature' }, { status: 401 });
  }
  const event = req.headers.get('x-github-event');
  if (!event || !['workflow_run', 'check_run', 'check_suite', 'pull_request'].includes(event)) {
    return Response.json({ ignored: true }, { status: 202 });
  }
  const delivery = req.headers.get('x-github-delivery');
  if (!delivery || delivery.length > 200) {
    return Response.json({ error: 'delivery ID required' }, { status: 400 });
  }
  let payload;
  try { payload = JSON.parse(body); }
  catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (event === 'pull_request' && !['opened', 'reopened', 'synchronize'].includes(payload?.action)) {
    return Response.json({ ignored: true }, { status: 202 });
  }
  const repository = payload?.repository?.full_name;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return Response.json({ error: 'repository required' }, { status: 400 });
  }
  try { githubCIService.accept(delivery, event, repository); }
  catch { return Response.json({ error: 'could not persist GitHub delivery' }, { status: 503 }); }
  return Response.json({ accepted: true }, { status: 202 });
}
