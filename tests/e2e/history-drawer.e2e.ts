import { expect, test, type Page } from '@playwright/test';
import type { RunRecord } from '../../lib/shared/workflow';
import { API_TOKEN, CRASH_WORKFLOW_ID, DEFAULT_WORKFLOW_ID } from './lib/env';

const startedAt = 1_700_000_000_000;

function finishedRun(runId: string, workflowId: string, errorMessage: string, offset: number) {
  return {
    runId,
    workflowId,
    workflowName: workflowId === DEFAULT_WORKFLOW_ID ? 'E2E Smoke' : 'E2E Crash Recovery',
    status: 'failed' as const,
    startedAt: startedAt + offset,
    finishedAt: startedAt + offset + 1_500,
    durationMs: 1_500,
    errorMessage,
    eventCount: 2,
  };
}

const newerOtherFlow = finishedRun('newer-other-flow', CRASH_WORKFLOW_ID, 'other workflow failure', 60_000);
const newerSameFlow = finishedRun('newer-same-flow', DEFAULT_WORKFLOW_ID, 'newer run failure', 30_000);
const olderTarget = finishedRun('older-target', DEFAULT_WORKFLOW_ID, 'selected older run failure', 0);

function recordFor(summary: ReturnType<typeof finishedRun>): RunRecord {
  return {
    ...summary,
    scope: { inputs: { selectedRun: summary.runId } },
    events: [
      { type: 'run_started', workflowId: summary.workflowId, workflowName: summary.workflowName },
      { type: 'run_finished', status: summary.status, scope: {} },
    ],
  };
}

async function mockJobs(page: Page): Promise<void> {
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ runs: [], state: { status: 'idle' }, slotPool: { capacity: 4, size: 0, waiters: 0 } }),
  }));
  await page.route('**/api/triggers/queue', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ size: 0, items: [] }),
  }));
  await page.route('**/api/runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ runs: [newerOtherFlow, newerSameFlow, olderTarget] }),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
  await mockJobs(page);
});

test('finished job opens the exact run and workflow history on home without changing the route', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requested: string[] = [];
  await page.route('**/api/runs/*/*', (route) => {
    requested.push(new URL(route.request().url()).pathname);
    const path = new URL(route.request().url()).pathname;
    const summary = [newerOtherFlow, newerSameFlow, olderTarget].find(
      (run) => path === `/api/runs/${run.workflowId}/${run.runId}`,
    );
    return route.fulfill({ status: summary ? 200 : 404, contentType: 'application/json', body: JSON.stringify(summary ? { run: recordFor(summary) } : { error: 'run not found' }) });
  });

  await page.goto('/');
  const jobs = page.getByRole('region', { name: 'Jobs' });
  const target = jobs.getByTestId('job-row-older-target');
  await expect(target).toHaveAttribute('data-status', 'failed');
  await target.getByRole('button', { name: 'View run older-target' }).click();

  const drawer = page.getByRole('dialog', { name: 'Run history detail' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('selected older run failure');
  await expect(drawer).not.toContainText('newer run failure');
  await expect(drawer).not.toContainText('other workflow failure');
  expect(requested).toEqual([`/api/runs/${DEFAULT_WORKFLOW_ID}/older-target`]);
  await expect(page).toHaveURL('/');
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('history-drawer-desktop.png'), fullPage: false });
});

test('browser Forward closes a home Jobs detail before restoring the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/runs/*/*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ run: recordFor(olderTarget) }),
  }));
  await page.goto('/');
  await page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`).click();
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/');
  const target = page.getByRole('region', { name: 'Jobs' })
    .getByTestId('job-row-older-target').getByRole('button', { name: 'View run older-target' });
  await target.click();
  const drawer = page.getByRole('dialog', { name: 'Run history detail' });
  await expect(drawer).toContainText('selected older run failure');

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(drawer).toHaveCount(0);
  const node = page.locator('[data-id="agent-1"]');
  await expect(node).toBeVisible();
  await node.click();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
});

test('closing a pending detail and opening another run ignores the late response', async ({ page }) => {
  let markFirstStarted!: () => void;
  let releaseFirst!: () => void;
  let markFirstDelivered!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstDelivered = new Promise<void>((resolve) => { markFirstDelivered = resolve; });
  await page.route('**/api/runs/*/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/older-target')) {
      markFirstStarted();
      await firstReleased;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: recordFor(olderTarget) }) }).catch(() => {});
      markFirstDelivered();
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: recordFor(newerSameFlow) }) });
    }
  });
  await page.goto('/');
  const jobs = page.getByRole('region', { name: 'Jobs' });
  const firstButton = jobs.getByTestId('job-row-older-target').getByRole('button', { name: 'View run older-target' });
  await firstButton.click();
  await firstStarted;
  const drawer = page.getByRole('dialog', { name: 'Run history detail' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close run history' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(firstButton).toBeFocused();

  await jobs.getByTestId('job-row-newer-same-flow').getByRole('button', { name: 'View run newer-same-flow' }).click();
  await expect(drawer).toContainText('newer run failure');
  releaseFirst();
  await firstDelivered;
  await expect(drawer).not.toContainText('selected older run failure');
  await expect(drawer).toContainText('newer run failure');
  await expect(page).toHaveURL('/');
});

test('detail load can be retried and the mobile drawer can scroll to the end', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let attempts = 0;
  await page.route('**/api/runs/*/*', (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) });
    }
    const record = recordFor(olderTarget);
    record.events = [
      record.events[0],
      ...Array.from({ length: 80 }, (_, index) => ({ type: 'error' as const, message: `detail line ${index}` })),
      record.events[1],
    ];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: record }) });
  });

  await page.goto('/');
  const target = page.getByTestId('job-row-older-target').getByRole('button', { name: 'View run older-target' });
  await target.click();
  const drawer = page.getByRole('dialog', { name: 'Run history detail' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('503');
  await drawer.getByRole('button', { name: /retry/i }).click();
  await expect(drawer).toContainText('selected older run failure');
  await expect(drawer).toContainText('detail line 79');
  expect(attempts).toBe(2);

  const bounds = await drawer.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(845);
  for (const control of [
    drawer.getByRole('heading', { name: 'Run history detail' }),
    drawer.getByRole('button', { name: 'Close run history' }),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(80);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('history-drawer-mobile.png'), fullPage: false });

  const lastLine = drawer.getByText('detail line 79');
  await lastLine.scrollIntoViewIfNeeded();
  const end = await lastLine.boundingBox();
  expect(end).not.toBeNull();
  expect(end!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
  expect(end!.y + end!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(target).toBeFocused();
  await expect(page).toHaveURL('/');
});
