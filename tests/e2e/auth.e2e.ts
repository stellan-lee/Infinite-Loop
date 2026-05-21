/*
 * Smoke check — the auth gate.
 *
 * With `INFLOOP_API_TOKEN` set the whole console is credential-gated. This
 * verifies the gate end-to-end: the API rejects anonymous callers, and a real
 * browser can sign in through the login page and reach the protected console.
 */
import { expect, test } from '@playwright/test';
import { API_TOKEN } from './lib/env';

test('a protected API route rejects requests with no credentials', async ({
  request,
}) => {
  const res = await request.get('/api/runs');
  expect(res.status()).toBe(401);
});

test('GET /api/auth reports the console is gated and not yet authed', async ({
  request,
}) => {
  const res = await request.get('/api/auth');
  expect(res.ok()).toBeTruthy();

  const body = await res.json();
  expect(body.authRequired).toBe(true);
  expect(body.authenticated).toBe(false);
});

test('an anonymous browser is redirected to /login and can sign in', async ({
  page,
}) => {
  // The server-side page gate bounces an unauthenticated visit to /login.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await page.fill('#login-token', API_TOKEN);
  await page.click('button.login-submit');

  // A valid token sets the session cookie and lands back on the console.
  await expect(page.locator('.top-bar')).toBeVisible();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);
});

test('a rejected token surfaces an error and stays on /login', async ({
  page,
}) => {
  await page.goto('/login');
  await page.fill('#login-token', 'definitely-the-wrong-token');
  await page.click('button.login-submit');

  await expect(page.locator('.login-error')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
