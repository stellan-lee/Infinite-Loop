import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { listWebhookReceipts } from '@/lib/server/webhook-receipt-store';
import { isCorrelationId } from '@/lib/server/correlation';

export async function GET(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const params = new URL(req.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const before = params.get('before') ?? undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before && !isCorrelationId(before))) {
    return NextResponse.json({ error: 'invalid-pagination' }, { status: 400 });
  }
  try {
    return NextResponse.json(listWebhookReceipts({
      workflowId: params.get('workflowId') ?? undefined,
      triggerId: params.get('triggerId') ?? undefined,
      before,
      limit,
    }));
  } catch {
    return NextResponse.json({ error: 'receipts-unavailable' }, { status: 500 });
  }
}
