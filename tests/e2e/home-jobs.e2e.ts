import { expect, test, type Page } from '@playwright/test';
import { API_TOKEN, CRASH_WORKFLOW_ID, DEFAULT_WORKFLOW_ID } from './lib/env';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
});

async function controlJobEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler = (event: Event) => void;
    class ControlledEventSource {
      static instances: ControlledEventSource[] = [];
      onopen: Handler | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: Handler | null = null;
      private listeners: Record<string, Handler[]> = {};
      private closed = false;
      constructor(_url: string) {
        ControlledEventSource.instances.push(this);
        setTimeout(() => this.dispatch('open', new Event('open')), 0);
      }
      addEventListener(type: string, handler: Handler) {
        (this.listeners[type] ??= []).push(handler);
      }
      removeEventListener(type: string, handler: Handler) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== handler);
      }
      close() { this.closed = true; }
      private dispatch(type: string, event: Event) {
        if (this.closed) return;
        if (type === 'open') this.onopen?.(event);
        if (type === 'message') this.onmessage?.(event as MessageEvent);
        for (const handler of this.listeners[type] ?? []) handler(event);
      }
      emit(data: unknown) {
        this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(data) }));
      }
    }
    (window as unknown as { EventSource: typeof EventSource }).EventSource = ControlledEventSource as unknown as typeof EventSource;
    (window as unknown as { __controlledJobSources: ControlledEventSource[] }).__controlledJobSources = ControlledEventSource.instances;
  });
}

async function emitJobEvent(page: Page, event: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const sources = (window as unknown as { __controlledJobSources: Array<{ emit: (value: unknown) => void }> }).__controlledJobSources;
    for (const source of sources) source.emit(payload);
  }, event);
}

test('one jobs list combines live, queued, succeeded, and failed work with live time and stage', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('infinite_loop:theme', 'light'));
  await controlJobEvents(page);
  const now = Date.now();
  const live = {
    runId: 'job-live', workflowId: DEFAULT_WORKFLOW_ID,
    workflowName: 'E2E Smoke — start → agent → end', status: 'running',
    startedAt: now - 65_000,
  };
  let activeRuns = [live];
  let queueItems = [{
    queueId: 'job-queued', triggerId: 'trigger-1', workflowId: CRASH_WORKFLOW_ID,
    workflowName: 'E2E Crash Recovery', inputs: {}, receivedAt: now - 30_000, position: 1,
  }];
  const finishedRuns = [
    {
      runId: 'job-failed', workflowId: CRASH_WORKFLOW_ID, workflowName: 'E2E Crash Recovery',
      status: 'failed', startedAt: now - 210_000, finishedAt: now - 180_000,
      durationMs: 30_000, eventCount: 3,
    },
    {
      runId: 'job-succeeded', workflowId: DEFAULT_WORKFLOW_ID,
      workflowName: 'E2E Smoke — start → agent → end', status: 'succeeded',
      startedAt: now - 300_000, finishedAt: now - 270_000,
      durationMs: 30_000, eventCount: 3,
    },
  ];
  await page.route('**/api/run', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: activeRuns, state: { status: 'running' }, slotPool: { capacity: 4, size: 1, waiters: 0 } }) });
  });
  await page.route('**/api/triggers/queue', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ size: queueItems.length, items: queueItems }) });
  });
  await page.route('**/api/runs', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: finishedRuns }) });
  });

  await page.goto('/');
  const jobs = page.getByRole('region', { name: 'Jobs' });
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await expect(jobs.getByTestId('jobs-list')).toHaveCount(1);
  const ids = ['job-live', 'job-queued', 'job-failed', 'job-succeeded'];
  for (const id of ids) await expect(jobs.getByTestId(`job-row-${id}`)).toBeVisible();
  await expect(jobs.getByTestId('jobs-list').locator('li')).toHaveCount(4);
  expect(await jobs.getByTestId('jobs-list').locator('li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status'))))
    .toEqual(['running', 'queued', 'failed', 'succeeded']);

  const liveRow = jobs.getByTestId('job-row-job-live');
  const queuedRow = jobs.getByTestId('job-row-job-queued');
  const succeededRow = jobs.getByTestId('job-row-job-succeeded');
  const failedRow = jobs.getByTestId('job-row-job-failed');
  await expect(liveRow).toContainText(/Running/i);
  await expect(liveRow).toContainText(/\d\d:\d\d/);
  await expect(queuedRow).toContainText(/Queued/i);
  await expect(liveRow.getByRole('button', { name: /View run/i })).toHaveCount(0);
  await expect(queuedRow.getByRole('button', { name: /View run/i })).toHaveCount(0);
  await expect(succeededRow).toContainText(/Succeeded/i);
  await expect(failedRow).toContainText(/Failed/i);
  const colors = await page.evaluate(() => {
    const statusColor = (id: string, label: string) => {
      const row = document.querySelector(`[data-testid="job-row-${id}"]`)!;
      const status = [...row.querySelectorAll('*')].find((element) => element.textContent?.trim() === label);
      return getComputedStyle(status!).color;
    };
    const resolve = (token: string) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      live: statusColor('job-live', 'Running'), queued: statusColor('job-queued', 'Queued'),
      succeeded: statusColor('job-succeeded', 'Succeeded'), failed: statusColor('job-failed', 'Failed'),
      liveToken: resolve('--accent-live'), neutralToken: resolve('--fg-dim'),
      okToken: resolve('--accent-ok'), errorToken: resolve('--accent-err'),
    };
  });
  expect(colors.live).toBe(colors.liveToken);
  expect(colors.queued).toBe(colors.neutralToken);
  expect(colors.succeeded).toBe(colors.okToken);
  expect(colors.failed).toBe(colors.errorToken);

  await expect.poll(async () => page.evaluate(() => (window as unknown as { __controlledJobSources: unknown[] }).__controlledJobSources.length)).toBeGreaterThan(0);
  await emitJobEvent(page, {
    type: 'state_snapshot',
    runs: [{ runId: live.runId, workflowId: live.workflowId, status: 'running', startedAt: live.startedAt, currentNodeId: 'agent-1', scope: {}, iterationByLoopId: {}, events: [] }],
    state: { status: 'running', runId: live.runId, workflowId: live.workflowId, startedAt: live.startedAt, currentNodeId: 'agent-1', scope: {}, iterationByLoopId: {}, events: [] },
  });
  await expect(liveRow).toContainText(/Agent|agent-1/i);
  const elapsedBefore = await liveRow.innerText();
  await expect.poll(async () => liveRow.innerText(), { timeout: 5_000 }).not.toBe(elapsedBefore);
  const flowList = page.getByTestId('flow-list');
  const desktopFlows = await flowList.boundingBox();
  const desktopJobs = await jobs.boundingBox();
  expect(desktopFlows).not.toBeNull();
  expect(desktopJobs).not.toBeNull();
  expect(desktopFlows!.x + desktopFlows!.width).toBeLessThanOrEqual(desktopJobs!.x + 4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('mixed-jobs-desktop-light.png'), fullPage: true });

  await page.getByRole('button', { name: 'switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('mixed-jobs-desktop-dark.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFlows = await flowList.boundingBox();
  const mobileJobs = await jobs.boundingBox();
  expect(mobileFlows).not.toBeNull();
  expect(mobileJobs).not.toBeNull();
  expect(mobileJobs!.y).toBeGreaterThanOrEqual(mobileFlows!.y + mobileFlows!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const mobileHeader = await page.locator('header.flow-home-bar').boundingBox();
  const mobileMain = await page.locator('main.flow-home').boundingBox();
  expect(mobileHeader).not.toBeNull();
  expect(mobileMain).not.toBeNull();
  for (const control of [
    page.getByRole('button', { name: 'switch to light theme' }),
    page.getByRole('link', { name: 'Queue', exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(mobileHeader!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(mobileHeader!.x + mobileHeader!.width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(mobileHeader!.y - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(mobileHeader!.y + mobileHeader!.height + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(mobileMain!.y + 1);
  }
  await page.screenshot({ path: testInfo.outputPath('mixed-jobs-mobile.png'), fullPage: true });

  // The queued item becomes a live run in the same list. No duplicate queue
  // row should remain after the transition.
  queueItems = [];
  activeRuns = [...activeRuns, { runId: 'job-new', workflowId: CRASH_WORKFLOW_ID, workflowName: 'E2E Crash Recovery', status: 'running', startedAt: now }];
  await emitJobEvent(page, { type: 'trigger_started', queueId: 'job-queued', triggerId: 'trigger-1', workflowId: CRASH_WORKFLOW_ID, runId: 'job-new' });
  await emitJobEvent(page, { type: 'run_started', runId: 'job-new', workflowId: CRASH_WORKFLOW_ID, workflowName: 'E2E Crash Recovery' });
  await expect(queuedRow).toHaveCount(0);
  await expect(jobs.getByTestId('job-row-job-new')).toHaveAttribute('data-status', 'running');
  await expect(jobs.getByTestId('jobs-list').locator('li')).toHaveCount(4);
  await emitJobEvent(page, { type: 'run_finished', runId: 'job-new', status: 'succeeded', scope: {} });
  await expect(jobs.getByTestId('job-row-job-new')).toHaveAttribute('data-status', 'succeeded');
});

test('jobs failure is visible without blocking flows and Retry recovers', async ({ page }) => {
  await page.route('**/api/runs', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
  });
  await page.goto('/');
  const jobs = page.getByRole('region', { name: 'Jobs' });
  await expect(page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`)).toBeVisible();
  await expect(jobs.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/runs');
  await jobs.getByRole('button', { name: 'Retry' }).click();
  await expect(jobs.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`)).toBeVisible();
});
