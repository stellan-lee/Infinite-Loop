/*
 * Smoke check — the liveness/readiness probe.
 *
 * `/api/health` is intentionally unauthenticated; a deployment's load balancer
 * or supervisor must be able to probe it without credentials.
 */
import { expect, test } from '@playwright/test';

test('GET /api/health answers 200 without credentials', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);

  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(typeof body.version).toBe('string');
  expect(typeof body.uptimeSeconds).toBe('number');
});
