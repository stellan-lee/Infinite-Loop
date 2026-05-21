import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  isAuthEnabled,
  isValidToken,
  requireAuth,
  sessionCookieValue,
} from '@/lib/server/auth';
import { recordAudit } from '@/lib/server/audit-log';

/**
 * Session endpoint for the browser UI.
 *
 *   GET    /api/auth  — status: { authRequired, authenticated }. Ungated; the
 *                       login page calls this before the user has credentials.
 *   POST   /api/auth  — log in: body { token }. On success sets the httpOnly
 *                       `infloop_session` cookie.
 *   DELETE /api/auth  — log out: clears the cookie.
 *
 * API / MCP clients keep authenticating with `Authorization: Bearer` and never
 * touch this route; the webhook ingress route stays exempt from auth entirely.
 */

// 7 days. The session lives only in the browser cookie — there is no
// server-side store — so this is its practical lifetime. Rotating
// INFLOOP_API_TOKEN invalidates every issued cookie immediately regardless.
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;

/**
 * Cookie attributes shared by login (set) and logout (clear).
 *
 * `sameSite: 'strict'` so the cookie is never sent on any cross-site request —
 * defense in depth against CSRF for a tool that executes arbitrary code. The
 * only cost is that following an external link to the console lands on
 * `/login` first; the login page then re-checks `/api/auth` (a same-origin
 * request that does carry the cookie) and bounces straight back.
 *
 * `secure` is set only when an upstream proxy reports HTTPS via
 * `x-forwarded-proto`: the app itself serves plain HTTP, and a `secure` cookie
 * would never be stored or sent back over a plain-HTTP origin. A client can
 * spoof that header, but doing so only locks out its own session — it cannot
 * affect another browser — so this is safe to trust here.
 */
function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: req.headers.get('x-forwarded-proto') === 'https',
  };
}

export async function GET(req: Request) {
  return NextResponse.json({
    authRequired: isAuthEnabled(),
    // requireAuth returns null when the request is authorized OR when no token
    // is configured, so this is true in open mode too.
    authenticated: requireAuth(req) === null,
  });
}

export async function POST(req: Request) {
  if (!isAuthEnabled()) {
    // Open mode — nothing to log into. Report success so the login page can
    // simply send the user on to the app.
    return NextResponse.json({ ok: true });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const token =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).token
      : undefined;
  if (typeof token !== 'string' || !isValidToken(token)) {
    await recordAudit({
      category: 'auth',
      action: 'login',
      outcome: 'failure',
      actor: 'browser-session',
      detail: {
        reason: typeof token !== 'string' ? 'missing-token' : 'invalid-token',
      },
    });
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, sessionCookieValue(token), {
    ...cookieOptions(req),
    maxAge: SESSION_MAX_AGE_S,
  });
  await recordAudit({
    category: 'auth',
    action: 'login',
    outcome: 'success',
    actor: 'browser-session',
  });
  return res;
}

export async function DELETE(req: Request) {
  const res = NextResponse.json({ ok: true });
  // maxAge 0 expires the cookie immediately.
  res.cookies.set(SESSION_COOKIE_NAME, '', { ...cookieOptions(req), maxAge: 0 });
  // Only audit logout when auth is enabled — a logout in open mode crosses no
  // security boundary and would just be noise.
  if (isAuthEnabled()) {
    await recordAudit({
      category: 'auth',
      action: 'logout',
      outcome: 'info',
      actor: 'browser-session',
    });
  }
  return res;
}
