import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { getWebhookReceipt } from '@/lib/server/webhook-receipt-store';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await params;
  try {
    const receipt = getWebhookReceipt(id);
    if (!receipt) return NextResponse.json({ error: 'not-found' }, { status: 404 });
    const { serverPid: _serverPid, supersededRunIds: _supersededRunIds, ...publicReceipt } = receipt;
    return NextResponse.json({ receipt: publicReceipt });
  } catch {
    return NextResponse.json({ error: 'receipt-unavailable' }, { status: 500 });
  }
}
