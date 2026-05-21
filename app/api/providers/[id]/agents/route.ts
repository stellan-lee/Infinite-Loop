import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { getProvider } from '@/lib/server/providers/loader';
import {
  listCliAgents,
  type CliAgent,
} from '@/lib/server/providers/list-cli-agents';
import { createLogger } from '@/lib/server/logger';

const log = createLogger('providers');

interface AgentsResponse {
  agents: CliAgent[];
  /** Set when discovery failed (e.g. provider doesn't ship an `agents`
   * subcommand, binary missing, timeout). Short generic reason; details
   * land in the server log only — we never echo raw stderr to the client. */
  error?: string;
  /** Echoes the cwd the listing ran in, so the client can detect stale
   * fetches after the user changes the node's working directory. */
  cwd?: string;
}

/**
 * GET /api/providers/<id>/agents?cwd=<abs-path> — list the CLI provider's
 * available agents.
 *
 * The cwd matters: `claude agents` resolves user/project/local agents from
 * the working directory's settings stack. Without it a project-scoped agent
 * (defined under `<workflow-cwd>/.claude/agents/`) wouldn't appear.
 *
 * Returns 200 even on probe failure (with `error` set) so the UI can fall
 * back to free-text without surfacing a noisy red toast. Only invalid
 * inputs (unknown id, wrong transport) return non-2xx.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await params;
  const manifest = await getProvider(id);
  if (!manifest) {
    return NextResponse.json(
      { error: `unknown provider: ${id}` },
      { status: 404 },
    );
  }
  if (manifest.transport !== 'cli') {
    return NextResponse.json(
      { error: `provider "${id}" has no agent listing (transport=${manifest.transport})` },
      { status: 400 },
    );
  }
  const url = new URL(req.url);
  const rawCwd = url.searchParams.get('cwd') ?? undefined;
  // Only honour absolute paths to keep the probe deterministic; relative
  // paths would resolve against the server's cwd and silently give the
  // wrong answer.
  const cwd =
    rawCwd && rawCwd.startsWith('/') && rawCwd.length > 0 ? rawCwd : undefined;
  try {
    const agents = await listCliAgents(manifest, { cwd });
    const resp: AgentsResponse = { agents, cwd };
    return NextResponse.json(resp);
  } catch (err) {
    // Log the detail server-side; return a generic reason to the client so
    // we never leak filesystem paths or stderr.
    log.warn('agents probe failed', {
      providerId: id,
      cwd: cwd ?? '(server cwd)',
      err,
    });
    const resp: AgentsResponse = {
      agents: [],
      cwd,
      error: 'agent listing unavailable',
    };
    return NextResponse.json(resp);
  }
}
