import { afterEach, describe, expect, it } from 'bun:test';
import type { NextRequest, NextResponse } from 'next/server';
import { middleware } from './middleware';
import { SESSION_COOKIE_NAME, sessionCookieValue } from '@/lib/server/auth';

const orig = process.env.INFLOOP_API_TOKEN;

afterEach(() => {
  if (orig === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = orig;
});

const TOKEN = 'test-secret-token';

/**
 * Calls the middleware with a `NextRequest` double. A real `Request` silently
 * drops the forbidden `Cookie` header, so — as in auth.test.ts — a header
 * double is the only way to exercise the cookie path. The middleware only ever
 * reads `nextUrl.pathname`, `url`, and `headers.get(...)`.
 */
function call(pathname: string, headers: Record<string, string> = {}): NextResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const req = {
    nextUrl: { pathname },
    url: `http://localhost${pathname}`,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
  return middleware(req);
}

/** A `Cookie` header carrying a valid session cookie for the test token. */
function sessionCookie(token = TOKEN): string {
  return `${SESSION_COOKIE_NAME}=${sessionCookieValue(token)}`;
}

/** True when the middleware let the request through to the route/page. */
function passedThrough(res: NextResponse): boolean {
  return res.headers.get('x-middleware-next') === '1';
}

/** True when the middleware redirected the request to the login page. */
function redirectedToLogin(res: NextResponse): boolean {
  return res.status === 307 && (res.headers.get('location') ?? '').endsWith('/login');
}

describe('middleware — open mode (no INFLOOP_API_TOKEN)', () => {
  it('lets every kind of path through', () => {
    delete process.env.INFLOOP_API_TOKEN;
    for (const p of [
      '/',
      '/queue',
      '/login',
      '/api/providers',
      '/api/run',
      '/api/webhook/abc',
      '/api/mcp/output',
    ]) {
      expect(passedThrough(call(p))).toBe(true);
    }
  });
});

describe('middleware — authed mode, API routes', () => {
  it('401s an API call with no credential', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(call('/api/providers').status).toBe(401);
  });

  it('passes an API call with a correct bearer token', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    const res = call('/api/providers', { authorization: `Bearer ${TOKEN}` });
    expect(passedThrough(res)).toBe(true);
  });

  it('passes an API call with a valid session cookie', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/api/providers', { cookie: sessionCookie() }))).toBe(true);
  });

  it('401s an API call with a wrong bearer token', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(call('/api/providers', { authorization: 'Bearer wrong' }).status).toBe(401);
  });
});

describe('middleware — authed mode, pages', () => {
  it('redirects an unauthenticated page request to /login', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(redirectedToLogin(call('/'))).toBe(true);
    expect(redirectedToLogin(call('/queue'))).toBe(true);
  });

  it('passes an authenticated page request', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/', { cookie: sessionCookie() }))).toBe(true);
  });

  it('never gates the login page itself (no redirect loop)', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/login'))).toBe(true);
  });
});

describe('middleware — authed mode, exempt API surfaces', () => {
  it('never gates /api/auth (login / logout / status)', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/api/auth'))).toBe(true);
  });

  it('never gates webhook ingress', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/api/webhook/some-trigger-id'))).toBe(true);
  });

  it('never gates the SetOutput MCP server (per-run-token auth)', () => {
    // Regression guard: gating this would 401 every agent node's set_output
    // callback, because the agent CLI carries a per-run token, not the
    // global INFLOOP_API_TOKEN.
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/api/mcp/output'))).toBe(true);
  });

  it('never gates /api/health (unauthenticated liveness probe)', () => {
    // Regression guard: gating this would 401 the health/version probe
    // exactly in token-gated headless mode, where monitoring needs it most.
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(passedThrough(call('/api/health'))).toBe(true);
  });

  it('still gates /api/webhook-plugins — NOT part of the webhook exemption', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(call('/api/webhook-plugins').status).toBe(401);
  });

  it('still gates the main /api/mcp endpoint', () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    expect(call('/api/mcp').status).toBe(401);
  });
});
