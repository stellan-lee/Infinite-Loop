/*
 * Smoke check — the run loop.
 *
 * Triggers a workflow from the UI, confirms run events stream to the browser
 * over SSE, and confirms the finished run is persisted to history. This is the
 * core product flow — engine, stub provider, event bus, and run store composed.
 */
import { expect, test } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID } from './lib/env';

interface SseProbeWindow extends Window {
  __e2eSse?: EventSource;
  __e2eFrames?: number;
}

test('a UI-triggered run streams over SSE and lands succeeded in history', async ({
  page,
}) => {
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
  await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible({
    timeout: 20_000,
  });

  // Open an SSE channel and wait until it is genuinely connected BEFORE
  // triggering the run, so no run events can be missed. The EventSource rides
  // the authenticated session cookie — proving /api/events streams to a real
  // browser end-to-end.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const w = window as SseProbeWindow;
        const es = new EventSource('/api/events');
        w.__e2eSse = es;
        w.__e2eFrames = 0;
        es.addEventListener('message', () => {
          w.__e2eFrames = (w.__e2eFrames ?? 0) + 1;
        });
        es.addEventListener('open', () => resolve());
        // Resolve anyway after 5s so a stalled handshake fails loudly later
        // rather than hanging the test here.
        setTimeout(resolve, 5_000);
      }),
  );

  const runButton = page.locator('button[aria-label="run workflow"]');
  await expect(runButton).toBeEnabled();
  await runButton.click();

  // Let run events flow, then read how many SSE frames arrived: the initial
  // state_snapshot plus at least one run event.
  await page.waitForTimeout(8_000);
  const frames = await page.evaluate(() => {
    const w = window as SseProbeWindow;
    w.__e2eSse?.close();
    return w.__e2eFrames ?? 0;
  });
  expect(frames).toBeGreaterThan(1);

  // The finished run is persisted — proves the engine drove start → agent → end
  // and the run store recorded a terminal record.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/runs?workflowId=${DEFAULT_WORKFLOW_ID}`,
        );
        if (!res.ok()) return [];
        const body = await res.json();
        return (body.runs ?? []).map((r: { status: string }) => r.status);
      },
      { timeout: 30_000 },
    )
    .toContain('succeeded');
});
