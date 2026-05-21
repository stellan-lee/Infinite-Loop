import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/server/auth';

/*
 * Fail-closed auth gate for the whole app.
 *
 * Every handler in `app/api/**` already calls `requireAuth()` at its top — or,
 * for the SetOutput MCP server, its own per-run-token check. That per-route
 * call is the security boundary. This middleware is the *default*: it gates
 * every path before the route runs, so a new route added without its own
 * `requireAuth()` call is still protected rather than silently public. Pages
 * get the same treatment, complementing `guardPage()`.
 *
 * It is intentionally additive — it does NOT replace the per-route checks.
 * Next.js middleware has had bypass bugs (CVE-2025-29927); for a tool that
 * executes arbitrary code the route-level check stays as defense in depth.
 *
 * Runs on the Node.js runtime so it can reuse the exact `node:crypto`-based
 * `requireAuth` implementation instead of a second, Edge-only crypto path.
 */

/**
 * Paths reachable WITHOUT `INFLOOP_API_TOKEN` auth, by design:
 *  - `/login`          — the login page itself (gating it would loop).
 *  - `/api/auth`       — login / logout / status; called before credentials exist.
 *  - `/api/webhook/…`  — webhook ingress; the unguessable triggerId is the
 *                        credential (external senders can't add auth headers).
 *  - `/api/mcp/output` — SetOutput MCP server; authenticated by a separate
 *                        per-run token, not the global one (see that route).
 *  - `/api/health`     — unauthenticated liveness/readiness probe; the
 *                        payload (status, version, uptime) exposes nothing
 *                        sensitive.
 *
 * NOTE: the `/api/webhook/` match is a prefix — anything added under
 * `app/api/webhook/` inherits this exemption. Keep new token-authed routes
 * elsewhere, or they will be silently public.
 */
function isExempt(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/api/auth' ||
    pathname === '/api/mcp/output' ||
    pathname === '/api/health' ||
    pathname.startsWith('/api/webhook/')
  );
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (isExempt(pathname)) return NextResponse.next();

  // `requireAuth` returns null when the request is authorized OR when no token
  // is configured (open mode) — so open mode passes everything through.
  const unauthorized = requireAuth(req);
  if (!unauthorized) return NextResponse.next();

  // Gated, and the request carried no valid credential.
  //  - API calls get the JSON 401 straight from `requireAuth`.
  //  - Page navigations are sent to the login screen instead.
  if (pathname.startsWith('/api/')) return unauthorized;
  return NextResponse.redirect(new URL('/login', req.url));
}

export const runtime = 'nodejs';

export const config = {
  // Run on everything except Next's build output and the favicon. The security
  // allowlist itself lives in `isExempt`, not here, so it stays explicit and
  // unit-tested rather than buried in a matcher regex.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
