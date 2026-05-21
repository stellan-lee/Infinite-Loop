import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SESSION_COOKIE_NAME, sessionCookieValue } from './auth';

// guardPage() reaches for next/headers and next/navigation, neither of which
// has a request context under bun:test — so stub both. `cookies()` is driven
// by `cookieValue`; `redirect()` records its argument instead of throwing the
// NEXT_REDIRECT signal it raises in production.
const realHeaders = { ...(await import('next/headers')) };
const realNavigation = { ...(await import('next/navigation')) };

let redirectCalls: string[] = [];
let cookieValue: string | undefined;

mock.module('next/headers', () => ({
  ...realHeaders,
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && cookieValue !== undefined
        ? { value: cookieValue }
        : undefined,
  }),
}));
mock.module('next/navigation', () => ({
  ...realNavigation,
  redirect: (url: string) => {
    redirectCalls.push(url);
  },
}));

const { guardPage } = await import('./page-guard');

const orig = process.env.INFLOOP_API_TOKEN;

beforeEach(() => {
  redirectCalls = [];
  cookieValue = undefined;
});

afterEach(() => {
  if (orig === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = orig;
});

afterAll(() => {
  mock.module('next/headers', () => realHeaders);
  mock.module('next/navigation', () => realNavigation);
});

describe('guardPage', () => {
  it('does not redirect in open mode (no token configured)', async () => {
    delete process.env.INFLOOP_API_TOKEN;
    await guardPage();
    expect(redirectCalls).toEqual([]);
  });

  it('redirects to /login when a token is set and no cookie is present', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    cookieValue = undefined;
    await guardPage();
    expect(redirectCalls).toEqual(['/login']);
  });

  it('redirects to /login when the session cookie is invalid', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    cookieValue = 'bogus';
    await guardPage();
    expect(redirectCalls).toEqual(['/login']);
  });

  it('does not redirect when the session cookie is valid', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret';
    cookieValue = sessionCookieValue('secret');
    await guardPage();
    expect(redirectCalls).toEqual([]);
  });
});
