/*
 * Smoke check — the canvas.
 *
 * The product's pitch is a visual workflow canvas. This verifies the console
 * shell mounts and the auto-loaded default workflow renders as canvas nodes —
 * the seeded `start → agent → end` graph.
 */
import { expect, test } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID } from './lib/env';

test.beforeEach(async ({ page }) => {
  // Authenticate via the API; `page.request` shares the browser context's
  // cookie jar, so the subsequent navigation is already signed in.
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
});

test('the console shell loads and renders the seeded workflow', async ({
  page,
}) => {
  await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
  await expect(page.locator('.top-bar')).toBeVisible();

  // The flow URL selects the seeded workflow. Each rendered canvas node
  // carries its workflow node id.
  await expect(page.locator('[data-id="start-1"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await expect(page.locator('[data-id="end-1"]')).toBeVisible();
});
