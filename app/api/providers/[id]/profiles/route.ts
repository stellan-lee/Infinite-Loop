import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { getProvider } from '@/lib/server/providers/loader';
import type { HttpProviderManifest, HttpProviderProfile } from '@/lib/server/providers/types';

interface ProfilesResponse {
  profiles: HttpProviderProfile[];
  /** "live" = fetched from the provider's profilesEndpoint right now.
   * "static" = fell back to the manifest's `profiles` array because no
   * endpoint is configured or the live fetch failed. */
  source: 'live' | 'static';
}

/**
 * Fetch the live profile list from an HTTP provider, normalizing the
 * OpenAI `GET /v1/models` shape `{data: [{id, ...}]}` into our
 * `[{id, label?}]` contract. Throws on HTTP error so the caller can fall
 * back to the static list.
 */
async function fetchLiveProfiles(
  manifest: HttpProviderManifest,
): Promise<HttpProviderProfile[]> {
  if (!manifest.profilesEndpoint) {
    throw new Error('manifest has no profilesEndpoint configured');
  }
  const url = manifest.baseUrl + manifest.profilesEndpoint;
  // Provider-specific gateway headers are applied first; the protocol's
  // authorization and accept headers are owned by this endpoint.
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(manifest.headers ?? {}).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'content-type' && normalized !== 'accept';
    }),
  );
  headers.accept = 'application/json';
  if (manifest.auth?.type === 'bearer') {
    // Same precedence as the runner: inline token (UI-managed local file)
    // wins over env var (committed manifest).
    let token: string | undefined;
    if (manifest.auth.token) {
      token = manifest.auth.token;
    } else if (manifest.auth.envVar) {
      token = process.env[manifest.auth.envVar]?.trim();
      if (!token) {
        throw new Error(`env var ${manifest.auth.envVar} is not set`);
      }
    }
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}`);
  }
  const body = (await resp.json()) as unknown;
  return normalizeProfilesPayload(body);
}

/** Accept the OpenAI shape `{data: [{id}]}` or a bare `[{id, label?}]`. */
function normalizeProfilesPayload(body: unknown): HttpProviderProfile[] {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: unknown[] }).data)
      : null;
  if (!rows) return [];
  const out: HttpProviderProfile[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0) continue;
    out.push({
      id: r.id,
      label: typeof r.label === 'string' ? r.label : undefined,
    });
  }
  return out;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const { id } = await params;
  const manifest = await getProvider(id);
  if (!manifest) {
    return NextResponse.json({ error: `unknown provider: ${id}` }, { status: 404 });
  }
  if (manifest.transport !== 'http') {
    return NextResponse.json(
      { error: `provider "${id}" is not an http-transport provider` },
      { status: 400 },
    );
  }

  // No cache: profiles lists are small, the round-trip is cheap, and this is
  // a local single-user app. Caching here would tie the result to whichever
  // token was set at the time of the first call, which is exactly the kind
  // of staleness bug we'd rather not own.
  try {
    const profiles = await fetchLiveProfiles(manifest);
    const resp: ProfilesResponse = { profiles, source: 'live' };
    return NextResponse.json(resp);
  } catch (err) {
    const fallback = manifest.profiles ?? [];
    if (fallback.length === 0) {
      return NextResponse.json(
        {
          error: `failed to fetch profiles for "${id}" and no static fallback configured: ${(err as Error).message}`,
        },
        { status: 502 },
      );
    }
    const resp: ProfilesResponse = { profiles: fallback, source: 'static' };
    return NextResponse.json(resp);
  }
}
