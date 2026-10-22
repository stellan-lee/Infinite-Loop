import { requireAuth } from '@/lib/server/auth';
import { githubCIService } from '@/lib/server/github-ci-service';
export async function POST(req: Request): Promise<Response> {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    await githubCIService.drainInbox();
    await githubCIService.reconcile();
    return Response.json({ reconciled: true });
  } catch { return Response.json({ error: 'CI reconciliation failed' }, { status: 503 }); }
}
