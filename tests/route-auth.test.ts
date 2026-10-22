import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Fail-closed guard: every API route handler must enforce auth.
 *
 * `requireAuth` (global INFLOOP_API_TOKEN) guards almost every route;
 * `requireRunToken` guards the SetOutput MCP server with a per-run token. A
 * handler that calls neither is silently public — the fail-open regression
 * `middleware.ts` exists to stop at runtime. This test is the PR-time
 * counterpart: it fails the build the moment a `route.ts` gains an HTTP
 * handler without a matching auth call, independent of middleware integrity
 * (which Next.js bypass CVEs have historically undermined).
 *
 * The check is a deliberate heuristic, not an AST parse: it asserts a route
 * file has at least as many `requireAuth`/`requireRunToken` calls as exported
 * HTTP handlers. That catches the realistic mistake — a new handler added
 * without its auth call — while staying simple.
 */

const API_DIR = join(import.meta.dir, '..', 'app', 'api');

/** Routes intentionally not guarded by an auth function, with the reason. */
const EXEMPT = new Map<string, string>([
  [
    'webhook/github-ci/route.ts',
    'GitHub CI ingress requires mandatory HMAC-SHA256 verification with a ' +
      'server-configured secret before durable acceptance; covered by github-ci-service.test.ts',
  ],
  [
    'webhook/[triggerId]/route.ts',
    'webhook ingress — the unguessable triggerId is the credential, and ' +
      'external senders (e.g. GitHub) cannot attach auth headers',
  ],
  [
    'auth/route.ts',
    'the login/logout/status endpoint itself — POST validates the token, ' +
      'DELETE clears the cookie; neither can require a prior session',
  ],
  [
    'health/route.ts',
    'unauthenticated liveness/readiness probe — it must answer without ' +
      'credentials, and its payload (status, version, uptime, timestamp) ' +
      'exposes nothing sensitive; the matching middleware.ts exemption is ' +
      'covered by middleware.test.ts',
  ],
]);

/** Exported HTTP method handlers, e.g. `export async function GET(...)`. */
const HANDLER_RE =
  /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
/** Calls to an auth function, e.g. `requireAuth(req)` — call form, not imports. */
const AUTH_CALL_RE = /\b(?:requireAuth|requireRunToken)\s*\(/g;

/** Collects every `route.ts` under `dir`, as paths relative to `dir`. */
function findRouteFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...findRouteFiles(join(dir, entry.name), childRel));
    } else if (entry.name === 'route.ts') {
      out.push(childRel);
    }
  }
  return out;
}

describe('every API route enforces auth (fail-closed)', () => {
  const routes = findRouteFiles(API_DIR);

  it('discovers the API route files', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('keeps the exemption allowlist free of stale entries', () => {
    for (const exempt of EXEMPT.keys()) {
      expect(routes).toContain(exempt);
    }
  });

  for (const route of routes) {
    it(`${route} guards every exported HTTP handler`, () => {
      if (EXEMPT.has(route)) return; // exempt by design — see EXEMPT above
      const src = readFileSync(join(API_DIR, route), 'utf8');
      const handlers = src.match(HANDLER_RE) ?? [];
      const authCalls = src.match(AUTH_CALL_RE) ?? [];
      expect(handlers.length).toBeGreaterThan(0);
      expect(authCalls.length).toBeGreaterThanOrEqual(handlers.length);
    });
  }
});
