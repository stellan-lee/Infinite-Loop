import { expect, test, type Page } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID } from './lib/env';

const seededFlowName = 'E2E Smoke — start → agent → end';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
});

async function openSeededFlow(page: Page): Promise<void> {
  await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
}

async function createDisposableFlow(page: Page, id: string, name: string): Promise<void> {
  const now = Date.now();
  const response = await page.request.post('/api/workflows', { data: {
    id, name, version: 1, createdAt: now, updatedAt: now,
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'end-1', type: 'end', position: { x: 200, y: 0 }, config: { outcome: 'succeeded' } },
    ],
    edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
  } });
  expect(response.ok()).toBe(true);
}

test('home lists flows and the chosen flow has a direct, refreshable URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await expect(page.locator('[data-id="agent-1"]')).toHaveCount(0);
  await expect(page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`)).toContainText(seededFlowName);

  await page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`).click();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await page.getByRole('link', { name: 'All flows' }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
});

test('switching flows from home and browser history follow the URL', async ({ page }) => {
  await openSeededFlow(page);
  await expect(page.getByTestId('workflow-title')).toContainText(seededFlowName);
  await expect(page.getByRole('button', { name: 'workflow menu' })).toHaveCount(0);
  await page.getByRole('link', { name: 'All flows' }).click();
  await page.getByTestId('flow-row-crash-recovery-workflow').click();
  await expect(page).toHaveURL(/\/crash-recovery-workflow$/);
  await expect(page.getByTestId('workflow-title')).toContainText('E2E Crash Recovery');
  await page.goBack();
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.getByTestId('workflow-title')).toContainText(seededFlowName);
});

test('a late response for an earlier flow does not replace the selected flow', async ({ page }) => {
  await openSeededFlow(page);
  let releaseEarlierRequest!: () => void;
  let signalEarlierRequest!: () => void;
  let signalEarlierRequestFinished!: () => void;
  const earlierRequestStarted = new Promise<void>((resolve) => { signalEarlierRequest = resolve; });
  const earlierRequestMayFinish = new Promise<void>((resolve) => { releaseEarlierRequest = resolve; });
  const earlierRequestFinished = new Promise<void>((resolve) => { signalEarlierRequestFinished = resolve; });
  await page.route('**/api/workflows/crash-recovery-workflow', async (route) => {
    signalEarlierRequest();
    await earlierRequestMayFinish;
    try {
      await route.continue();
    } finally {
      signalEarlierRequestFinished();
    }
  });

  try {
    await page.getByRole('link', { name: 'All flows' }).click();
    await page.getByTestId('flow-row-crash-recovery-workflow').click();
    await earlierRequestStarted;
    await expect(page).toHaveURL(/\/crash-recovery-workflow$/);
    // The destination has a loading shell. Back traverses the home page,
    // then selects the earlier flow while the original request is pending.
    await page.goBack();
    await expect(page.getByTestId('flow-list')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
    await expect(page.getByTestId('workflow-title')).toContainText(seededFlowName);
  } finally {
    releaseEarlierRequest();
  }
  await earlierRequestFinished;
  // Give the earlier fetch continuation a browser turn to update React if it
  // is incorrectly allowed to overwrite the route-selected workflow.
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.getByTestId('workflow-title')).toContainText(seededFlowName);
  await expect(page.getByTestId('workflow-title')).not.toContainText('E2E Crash Recovery');
});

test('home distinguishes an empty list from a failed request and can retry', async ({ page }) => {
  await page.route('**/api/workflows', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"workflows":[]}' });
  });
  await page.goto('/');
  await expect(page.getByTestId('flow-empty')).toBeVisible();

  await page.unroute('**/api/workflows');
  await page.route('**/api/workflows', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
  });
  await page.reload();
  await expect(page.getByTestId('flow-list-error')).toBeVisible();

  await page.unroute('**/api/workflows');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`)).toBeVisible();
});

test('new flow opens at its URL and can be deleted from home', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-flow').click();
  await expect(page).toHaveURL(/\/workflow-\d+$/);
  const createdId = new URL(page.url()).pathname.slice(1);
  try {
    await expect(page.locator('[data-id="start-1"]')).toBeVisible();
    await expect(page.locator('[data-id="end-1"]')).toBeVisible();
    await page.getByRole('link', { name: 'All flows' }).click();
    await expect(page.getByTestId(`flow-row-${createdId}`)).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: `delete workflow ${createdId}` }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);
    await expect(page.getByTestId(`flow-row-${createdId}`)).toHaveCount(0);
    expect((await page.request.get(`/api/workflows/${createdId}`)).status()).toBe(404);
  } finally {
    // A failed UI assertion must not pollute later specs in the shared server.
    await page.request.delete(`/api/workflows/${createdId}`);
  }
});

test('home manages rename, cancel, and delete without opening the flow', async ({ page }) => {
  const id = `home-actions-${Date.now()}`;
  await createDisposableFlow(page, id, 'Manage me');
  try {
    await page.goto('/');
    const openLink = page.getByTestId(`flow-row-${id}`);
    await expect(openLink).toContainText('Manage me');

    await page.getByRole('button', { name: `rename workflow ${id}` }).click();
    const nameInput = page.getByRole('textbox', { name: `workflow name ${id}` });
    await nameInput.fill('Discard this name');
    await page.getByRole('button', { name: `cancel rename ${id}` }).click();
    await expect(openLink).toContainText('Manage me');
    expect((await (await page.request.get(`/api/workflows/${id}`)).json()).workflow.name).toBe('Manage me');

    await page.getByRole('button', { name: `rename workflow ${id}` }).click();
    await page.getByRole('textbox', { name: `workflow name ${id}` }).fill('Renamed on home');
    await page.getByRole('button', { name: `save workflow ${id}` }).click();
    await expect(openLink).toContainText('Renamed on home');
    await expect(openLink).toHaveAttribute('href', `/${id}`);
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: `delete workflow ${id}` }).click();
    await expect(openLink).toBeVisible();
    expect((await page.request.get(`/api/workflows/${id}`)).status()).toBe(200);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: `delete workflow ${id}` }).click();
    await expect(openLink).toHaveCount(0);
    expect((await page.request.get(`/api/workflows/${id}`)).status()).toBe(404);
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});

test('a failed home rename keeps the flow and shows an error on its row', async ({ page }) => {
  const id = `rename-failure-${Date.now()}`;
  await createDisposableFlow(page, id, 'Keep this name');
  try {
    await page.route(`**/api/workflows/${id}`, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
      } else {
        await route.continue();
      }
    });
    await page.goto('/');
    const openLink = page.getByTestId(`flow-row-${id}`);
    await page.getByRole('button', { name: `rename workflow ${id}` }).click();
    await page.getByRole('textbox', { name: `workflow name ${id}` }).fill('Should not persist');
    await page.getByRole('button', { name: `save workflow ${id}` }).click();
    await expect(openLink.locator('..').getByRole('alert')).toBeVisible();
    await expect(openLink).toContainText('Keep this name');
    expect((await (await page.request.get(`/api/workflows/${id}`)).json()).workflow.name).toBe('Keep this name');
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});

test('unknown flow shows an error without opening another flow', async ({ page }) => {
  await page.goto('/not-a-real-flow-e2e');
  await expect(page.getByTestId('flow-load-error')).toBeVisible();
  await expect(page.locator('[data-id="agent-1"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'All flows' }).click();
  await expect(page.getByTestId('flow-list')).toBeVisible();
});

test('Dispatch opens on home, preserves workflow filters from legacy editor links, and navigates with browser history', async ({ page }) => {
  await page.goto(`/${DEFAULT_WORKFLOW_ID}#dispatch?workflow=${DEFAULT_WORKFLOW_ID}`);
  await expect(page).toHaveURL(new RegExp(`/#dispatch\\?workflow=${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.getByRole('button', { name: 'Dispatch' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Dispatch' })).toBeVisible();
  await expect(page.locator('.dsp-filter-chip')).toContainText(DEFAULT_WORKFLOW_ID);
  await expect(page.getByTestId('flow-list')).toHaveCount(0);

  await page.getByRole('link', { name: 'Inf·Loop home' }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/#dispatch\\?workflow=${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.getByRole('heading', { name: 'Dispatch' })).toBeVisible();
  await page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(page.getByTestId('flow-list')).toBeVisible();
});

test('browser Back from a legacy editor Dispatch hash returns to the clean editor without looping', async ({ page }) => {
  await openSeededFlow(page);
  // The old workflow-scoped Manage link changed the hash on the editor page.
  // That creates a same-document history entry before the redirect to home.
  await page.evaluate((id) => { window.location.hash = `#dispatch?workflow=${encodeURIComponent(id)}`; }, DEFAULT_WORKFLOW_ID);
  await expect(page).toHaveURL(new RegExp(`/#dispatch\\?workflow=${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('.dsp-filter-chip')).toContainText(DEFAULT_WORKFLOW_ID);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
});

test('global Dispatch, Queue, and theme controls live on home and fit narrow widths', async ({ page }) => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/');
    const header = page.locator('header.flow-home-bar');
    for (const control of [
      page.getByRole('button', { name: 'Dispatch' }),
      page.getByRole('link', { name: 'Queue', exact: true }),
      header.locator('.theme-toggle'),
    ]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.y).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await openSeededFlow(page);
    await expect(page.getByRole('button', { name: 'Dispatch' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Queue', exact: true })).toHaveCount(0);
    await expect(page.locator('header.top-bar .theme-toggle')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Inf·Loop home' })).toBeVisible();
  }
});

test('leaving a dirty editor persists the edit before opening the list', async ({ page }) => {
  await openSeededFlow(page);
  const original = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
  const editedMessage = 'Browser navigation message edit';
  try {
    await page.locator('[data-id="agent-1"]').click();
    await page.getByRole('textbox', { name: 'user message 1' }).fill(editedMessage);
    // Message changes enter the editor store immediately. Leave while its
    // workflow autosave is still pending.
    await expect(page.getByTestId('workflow-title')).toContainText('•');
    await page.getByRole('link', { name: 'All flows' }).click();
    await expect(page.getByTestId('flow-list')).toBeVisible();
    const saved = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
    expect(saved.nodes.find((node: { id: string }) => node.id === 'agent-1').config.messages[0].content).toBe(editedMessage);
  } finally {
    await page.request.put(`/api/workflows/${DEFAULT_WORKFLOW_ID}`, { data: original });
  }
});

test('immediately leaving after typing Display name saves its pending field edit', async ({ page }) => {
  await openSeededFlow(page);
  const original = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
  const editedLabel = 'Immediate list navigation edit';
  try {
    await page.locator('[data-id="agent-1"]').click();
    await page.getByRole('textbox', { name: 'Display name' }).fill(editedLabel);
    // No dirty-marker wait: the field's own debounce has not necessarily
    // committed to the store when navigation begins.
    await page.getByRole('link', { name: 'All flows' }).click();
    await expect(page.getByTestId('flow-list')).toBeVisible();
    const saved = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
    expect(saved.nodes.find((node: { id: string }) => node.id === 'agent-1').label).toBe(editedLabel);
  } finally {
    await page.request.put(`/api/workflows/${DEFAULT_WORKFLOW_ID}`, { data: original });
  }
});

test('immediate flow switch saves the old Display name without copying it to same-ID nodes', async ({ page }) => {
  await openSeededFlow(page);
  const original = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
  const crash = (await (await page.request.get('/api/workflows/crash-recovery-workflow')).json()).workflow;
  const crashLabel = crash.nodes.find((node: { id: string }) => node.id === 'agent-1').label ?? '';
  const editedLabel = 'Immediate flow switch edit';
  try {
    await page.locator('[data-id="agent-1"]').click();
    await page.getByRole('textbox', { name: 'Display name' }).fill(editedLabel);
    await page.getByRole('link', { name: 'All flows' }).click();
    await page.getByTestId('flow-row-crash-recovery-workflow').click();
    await expect(page).toHaveURL(/\/crash-recovery-workflow$/);
    await expect(page.getByTestId('workflow-title')).toContainText('E2E Crash Recovery');
    await page.locator('[data-id="agent-1"]').click();
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue(crashLabel);
    const saved = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
    expect(saved.nodes.find((node: { id: string }) => node.id === 'agent-1').label).toBe(editedLabel);
  } finally {
    await page.request.put(`/api/workflows/${DEFAULT_WORKFLOW_ID}`, { data: original });
  }
});

test('browser Back preserves pending edits before opening the list', async ({ page }) => {
  const original = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
  const editedMessage = 'Browser Back navigation edit';
  try {
    await page.goto('/');
    await page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`).click();
    await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
    await page.locator('[data-id="agent-1"]').click();
    await page.getByRole('textbox', { name: 'user message 1' }).fill(editedMessage);
    await expect(page.getByTestId('workflow-title')).toContainText('•');
    await page.goBack();
    await expect(page.getByTestId('flow-list')).toBeVisible();
    const saved = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
    expect(saved.nodes.find((node: { id: string }) => node.id === 'agent-1').config.messages[0].content).toBe(editedMessage);
  } finally {
    await page.request.put(`/api/workflows/${DEFAULT_WORKFLOW_ID}`, { data: original });
  }
});

test('a failed navigation save keeps the edited flow open', async ({ page }) => {
  await openSeededFlow(page);
  await page.route(`**/api/workflows/${DEFAULT_WORKFLOW_ID}`, async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    } else {
      await route.continue();
    }
  });
  await page.locator('[data-id="agent-1"]').click();
  await page.getByRole('textbox', { name: 'user message 1' }).fill('Save failure navigation test');
  await expect(page.getByTestId('workflow-title')).toContainText('•');
  await page.getByRole('link', { name: 'All flows' }).click();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('.workflow-save-error')).toContainText(/Could not save changes/);
  await expect(page.getByTestId('workflow-title')).toContainText('•');
});
