import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SESSION_COOKIE_NAME, sessionCookieValue } from '@/lib/server/auth';
import { listAuditEntries } from '@/lib/server/audit-log';
import { loginRateLimiter } from '@/lib/server/rate-limiter';
import { DELETE, GET, POST } from './route';

const orig = process.env.INFLOOP_API_TOKEN;

afterEach(() => {
  if (orig === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = orig;
});

function authReq(
  method: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return new Request('http://localhost/api/auth', { method, headers, body });
}

describe('GET /api/auth (status)', () => {
  it('reports open mode when no token is configured', async () => {
    delete process.env.INFLOOP_API_TOKEN;
    const body = await (await GET(authReq('GET'))).json();
    expect(body).toEqual({ authRequired: false, authenticated: true });
  });

  it('reports unauthenticated when a token is set and no credential is sent', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const body = await (await GET(authReq('GET'))).json();
    expect(body).toEqual({ authRequired: true, authenticated: false });
  });

  it('reports authenticated when a valid bearer token is sent', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await GET(authReq('GET', { headers: { authorization: 'Bearer secret' } }));
    expect(await res.json()).toEqual({ authRequired: true, authenticated: true });
  });
  // The session-cookie path of requireAuth (which this endpoint delegates to)
  // is covered directly in lib/server/auth.test.ts — it cannot be exercised
  // here because `Cookie` is a forbidden header the Request constructor drops.
});

describe('POST /api/auth (login)', () => {
  it('succeeds without setting a cookie in open mode', async () => {
    delete process.env.INFLOOP_API_TOKEN;
    const res = await POST(authReq('POST', { body: { token: 'whatever' } }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('sets an httpOnly session cookie on a correct token', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await POST(authReq('POST', { body: { token: 'secret' } }));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(cookie?.value).toBe(sessionCookieValue('secret'));
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('strict');
    expect(cookie?.path).toBe('/');
    // Plain HTTP (no x-forwarded-proto) — the cookie must not be Secure or the
    // browser would refuse to store it.
    expect(cookie?.secure).toBeFalsy();
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await POST(
      authReq('POST', {
        body: { token: 'secret' },
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(res.cookies.get(SESSION_COOKIE_NAME)?.secure).toBe(true);
  });

  it('rejects a wrong token with 401 and no cookie', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await POST(authReq('POST', { body: { token: 'wrong' } }));
    expect(res.status).toBe(401);
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('rejects a missing token field with 401', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await POST(authReq('POST', { body: {} }));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid JSON body with 400', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await POST(authReq('POST', { body: 'not json{' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/auth (logout)', () => {
  it('expires the session cookie', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const res = await DELETE(authReq('DELETE'));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});

describe('login rate limiting', () => {
  const origLimit = process.env.INFLOOP_LOGIN_RATE_LIMIT;

  beforeEach(() => {
    process.env.INFLOOP_LOGIN_RATE_LIMIT = '3';
    loginRateLimiter.reset();
  });
  afterEach(() => {
    if (origLimit === undefined) delete process.env.INFLOOP_LOGIN_RATE_LIMIT;
    else process.env.INFLOOP_LOGIN_RATE_LIMIT = origLimit;
    loginRateLimiter.reset();
  });

  it('429s with Retry-After once the attempt limit is exceeded', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const attempt = () => POST(authReq('POST', { body: { token: 'wrong' } }));
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: 'rate-limited' });
  });

  it('records a rate-limited login audit entry', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    const attempt = () => POST(authReq('POST', { body: { token: 'wrong' } }));
    await attempt();
    await attempt();
    await attempt();
    await attempt(); // fourth attempt is over the limit
    const entries = await listAuditEntries({ limit: 30 });
    expect(
      entries.some(
        (e) =>
          e.category === 'auth' &&
          e.action === 'login' &&
          e.outcome === 'failure' &&
          (e.detail as { reason?: string } | undefined)?.reason === 'rate-limited',
      ),
    ).toBe(true);
  });

  it('does not rate-limit in open mode', async () => {
    delete process.env.INFLOOP_API_TOKEN;
    // well past the limit — open mode returns before the limiter is consulted
    for (let i = 0; i < 6; i++) {
      const res = await POST(authReq('POST', { body: { token: 'x' } }));
      expect(res.status).toBe(200);
    }
  });
});

describe('audit logging', () => {
  // The route awaits recordAudit before returning, so the entry is on disk by
  // the time POST/DELETE resolves. Assertions are tolerant of unrelated
  // entries from other tests sharing the preloaded data dir.
  it('records a successful login', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    await POST(authReq('POST', { body: { token: 'secret' } }));
    const entries = await listAuditEntries({ limit: 10 });
    expect(
      entries.some(
        (e) => e.category === 'auth' && e.action === 'login' && e.outcome === 'success',
      ),
    ).toBe(true);
  });

  it('records a failed login', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    await POST(authReq('POST', { body: { token: 'wrong' } }));
    const entries = await listAuditEntries({ limit: 10 });
    expect(
      entries.some(
        (e) => e.category === 'auth' && e.action === 'login' && e.outcome === 'failure',
      ),
    ).toBe(true);
  });

  it('records a logout when auth is enabled', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    await DELETE(authReq('DELETE'));
    const entries = await listAuditEntries({ limit: 10 });
    expect(
      entries.some((e) => e.category === 'auth' && e.action === 'logout'),
    ).toBe(true);
  });
});
