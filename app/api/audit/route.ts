import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { clampLimit, listAuditEntries } from '@/lib/server/audit-log';

/**
 * GET /api/audit — recent audit-log entries, newest-first.
 *
 * Authenticated, unlike `/api/health`: the audit log is operational detail and
 * a reconnaissance signal, so it must never answer unauthenticated. `?limit=`
 * is clamped to `[1, 2000]` (default 200).
 *
 * `force-dynamic` — the response reflects live on-disk state and must never be
 * statically cached.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const raw = new URL(req.url).searchParams.get('limit');
  const limit = clampLimit(raw === null ? undefined : Number(raw));

  const entries = await listAuditEntries({ limit });
  return NextResponse.json({ entries });
}
