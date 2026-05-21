import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/** Name of the httpOnly cookie that carries the browser session. */
export const SESSION_COOKIE_NAME = 'infloop_session';

/**
 * True when `INFLOOP_API_TOKEN` is configured — i.e. the server is gated and
 * callers must present either a bearer token or a session cookie.
 */
export function isAuthEnabled(): boolean {
  return !!process.env.INFLOOP_API_TOKEN;
}

/**
 * The session-cookie value for a given token: a SHA-256 hash of the token
 * behind a versioned prefix.
 *
 * Deliberately NOT the raw token, so a leaked cookie can never be replayed as
 * the `Authorization: Bearer` credential (MCP / API clients) and never exposes
 * the literal `INFLOOP_API_TOKEN`. It is still a bearer credential in its own
 * right — a stolen cookie grants full access until the token is rotated — but
 * its blast radius is contained to this server.
 *
 * Stateless by design: there is no session store, so the value survives a
 * restart, and rotating `INFLOOP_API_TOKEN` invalidates every issued cookie.
 */
export function sessionCookieValue(token: string): string {
  return createHash('sha256').update(`infloop-session-v1:${token}`).digest('hex');
}

/** Constant-time check that a cookie value matches the expected session hash. */
export function verifySessionCookie(value: string, token: string): boolean {
  const expected = sessionCookieValue(token);
  // Both sides are fixed-length SHA-256 hex (64 chars); an unequal length means
  // a malformed or forged cookie. The length guard is also required because
  // timingSafeEqual throws on unequal-length buffers — and a hash's length is
  // not a secret, so the early return leaks nothing.
  if (value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

/** Constant-time check that a submitted token equals `INFLOOP_API_TOKEN`. */
export function isValidToken(candidate: string): boolean {
  const token = process.env.INFLOOP_API_TOKEN;
  return !!token && constantTimeEq(candidate, token);
}

/**
 * Page-gate predicate: returns true when an authed page may render for a
 * request carrying `cookieValue` as its session cookie. When no token is
 * configured the server is in open mode and every page is allowed.
 *
 * Server components cannot read the `Authorization` header the way API routes
 * do, so the page gate is cookie-only — which is correct: a browser only ever
 * authenticates via the cookie.
 */
export function isPageRequestAuthed(cookieValue: string | undefined): boolean {
  const token = process.env.INFLOOP_API_TOKEN;
  if (!token) return true;
  return !!cookieValue && verifySessionCookie(cookieValue, token);
}

/**
 * Returns `null` if the request is authorized (or if no token is configured),
 * or a `401` NextResponse to return immediately if not.
 *
 * When `INFLOOP_API_TOKEN` is unset, the server is in open mode and every call
 * is allowed — matches the original behaviour.
 *
 * When set, the request must carry one of:
 *   - `Authorization: Bearer <token>` — for MCP / API / scripted clients.
 *   - the `infloop_session` cookie — set by the login page, so the browser UI
 *     works. `fetch` and `EventSource` both send same-origin cookies
 *     automatically, but neither can attach a custom `Authorization` header.
 */
export function requireAuth(req: Request): NextResponse | null {
  const token = process.env.INFLOOP_API_TOKEN;
  if (!token) return null;

  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m && constantTimeEq(m[1].trimEnd(), token)) return null;

  const cookie = readCookie(req, SESSION_COOKIE_NAME);
  if (cookie && verifySessionCookie(cookie, token)) return null;

  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/** Reads a single cookie value from the request's `Cookie` header. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      // A malformed %-sequence in any cookie on the header must not crash the
      // route — decodeURIComponent throws on bad input. Fall back to the raw
      // value, which simply won't match a valid session hash.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
