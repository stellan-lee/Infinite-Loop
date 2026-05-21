import { afterEach, describe, expect, it } from 'bun:test';
import {
  SESSION_COOKIE_NAME,
  isAuthEnabled,
  isPageRequestAuthed,
  isValidToken,
  requireAuth,
  sessionCookieValue,
  verifySessionCookie,
} from './auth';

const orig = process.env.INFLOOP_API_TOKEN;

afterEach(() => {
  if (orig === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = orig;
});

/**
 * A minimal Request double. `requireAuth` only reads `req.headers.get(...)`,
 * and `Cookie` is a forbidden request header that the real `Request` /
 * `Headers` constructors silently drop — so a header double is the only way to
 * exercise the cookie path in a unit test. A server receiving a real request
 * has no such restriction.
 */
function req(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

/** A `Cookie` header carrying a valid session cookie for `token`. */
function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionCookieValue(token)}`;
}

describe('requireAuth — bearer token', () => {
  it('returns null when no token is configured (open mode)', () => {
    delete process.env.INFLOOP_API_TOKEN;
    expect(requireAuth(req())).toBeNull();
  });

  it('returns 401 when token is configured and no credential is present', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = requireAuth(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('returns 401 on wrong bearer token', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = requireAuth(req({ authorization: 'Bearer wrong' }));
    expect(res!.status).toBe(401);
  });

  it('returns null on correct bearer token', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    expect(requireAuth(req({ authorization: 'Bearer secret' }))).toBeNull();
  });

  it('accepts case-insensitive scheme', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    expect(requireAuth(req({ authorization: 'bearer secret' }))).toBeNull();
  });
});

describe('requireAuth — session cookie', () => {
  it('returns null on a valid session cookie', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    expect(requireAuth(req({ cookie: sessionCookie('secret') }))).toBeNull();
  });

  it('returns 401 on a forged/invalid session cookie', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = requireAuth(req({ cookie: `${SESSION_COOKIE_NAME}=deadbeef` }));
    expect(res!.status).toBe(401);
  });

  it('returns 401 on a cookie minted for a different (rotated) token', () => {
    process.env.INFLOOP_API_TOKEN = 'new-token';
    const res = requireAuth(req({ cookie: sessionCookie('old-token') }));
    expect(res!.status).toBe(401);
  });

  it('finds the session cookie among other cookies', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const cookie = `theme=dark; ${sessionCookie('secret')}; other=1`;
    expect(requireAuth(req({ cookie }))).toBeNull();
  });

  it('ignores the cookie entirely in open mode', () => {
    delete process.env.INFLOOP_API_TOKEN;
    expect(requireAuth(req({ cookie: `${SESSION_COOKIE_NAME}=anything` }))).toBeNull();
  });

  it('rejects a cookie with malformed percent-encoding without throwing', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const run = () => requireAuth(req({ cookie: `${SESSION_COOKIE_NAME}=%E0%A4` }));
    expect(run).not.toThrow();
    expect(run()!.status).toBe(401);
  });
});

describe('sessionCookieValue / verifySessionCookie', () => {
  it('is a 64-char hex SHA-256 digest', () => {
    expect(sessionCookieValue('secret')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for a token and differs across tokens', () => {
    expect(sessionCookieValue('a')).toBe(sessionCookieValue('a'));
    expect(sessionCookieValue('a')).not.toBe(sessionCookieValue('b'));
  });

  it('is never equal to the raw token', () => {
    expect(sessionCookieValue('secret')).not.toBe('secret');
  });

  it('verifies a value it produced and rejects everything else', () => {
    expect(verifySessionCookie(sessionCookieValue('secret'), 'secret')).toBe(true);
    expect(verifySessionCookie(sessionCookieValue('other'), 'secret')).toBe(false);
    expect(verifySessionCookie('', 'secret')).toBe(false);
    expect(verifySessionCookie('not-a-hash', 'secret')).toBe(false);
  });
});

describe('isValidToken', () => {
  it('is false when no token is configured', () => {
    delete process.env.INFLOOP_API_TOKEN;
    expect(isValidToken('anything')).toBe(false);
  });

  it('matches only the exact configured token', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    expect(isValidToken('secret')).toBe(true);
    expect(isValidToken('Secret')).toBe(false);
    expect(isValidToken('secret ')).toBe(false);
    expect(isValidToken('')).toBe(false);
  });
});

describe('isAuthEnabled / isPageRequestAuthed', () => {
  it('isAuthEnabled reflects INFLOOP_API_TOKEN presence', () => {
    delete process.env.INFLOOP_API_TOKEN;
    expect(isAuthEnabled()).toBe(false);
    process.env.INFLOOP_API_TOKEN = 'secret';
    expect(isAuthEnabled()).toBe(true);
  });

  it('isPageRequestAuthed allows any page in open mode', () => {
    delete process.env.INFLOOP_API_TOKEN;
    expect(isPageRequestAuthed(undefined)).toBe(true);
  });

  it('isPageRequestAuthed gates on the cookie when a token is set', () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    expect(isPageRequestAuthed(undefined)).toBe(false);
    expect(isPageRequestAuthed('bad')).toBe(false);
    expect(isPageRequestAuthed(sessionCookieValue('secret'))).toBe(true);
  });
});
