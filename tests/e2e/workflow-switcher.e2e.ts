import { expect, test } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID } from './lib/env';

const crashFlowId = 'crash-recovery-workflow';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
});

test('opening a flow continuously resizes the same list and the editor contents', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`)).toBeVisible();
  // Keep references to the actual home list and row. A replacement list can
  // have the right final width while still visibly jumping at navigation.
  await page.evaluate((id) => {
    const list = document.querySelector('[data-testid="flow-list"]')!;
    const row = document.querySelector(`[data-testid="flow-row-${id}"]`)!;
    const name = row.querySelector('.flow-row-name')!;
    const initialRowStyle = getComputedStyle(row);
    const state = {
      list, row,
      initialListWidth: list.getBoundingClientRect().width,
      initialNameSize: Number.parseFloat(getComputedStyle(name).fontSize),
      initialRowPadding: Number.parseFloat(initialRowStyle.paddingTop),
      samples: [] as { list: number; row: number; nameSize: number; rowPadding: number; editor: number; right: number }[],
      done: false,
      lostList: false,
    };
    (window as typeof window & { __flowMotion?: typeof state }).__flowMotion = state;
    let started: number | null = null;
    const sample = (time: number) => {
      const editor = document.querySelector('.workflow-editor-main');
      const workspace = editor?.querySelector('.workspace') as HTMLElement | null;
      if (!list.isConnected && location.pathname !== '/') {
        state.lostList = true;
        state.done = true;
        return;
      }
      if (workspace && editor) {
        started ??= time;
        const editorRect = editor.getBoundingClientRect();
        state.samples.push({
          list: list.getBoundingClientRect().width,
          row: row.getBoundingClientRect().width,
          nameSize: Number.parseFloat(getComputedStyle(name).fontSize),
          rowPadding: Number.parseFloat(getComputedStyle(row).paddingTop),
          editor: workspace.clientWidth,
          right: editorRect.right,
        });
      }
      if (started !== null && time - started > 800) state.done = true;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, DEFAULT_WORKFLOW_ID);
  await page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`).click();

  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await page.waitForFunction(() => (window as typeof window & { __flowMotion?: { done: boolean } }).__flowMotion?.done);
  const motion = await page.evaluate((id) => {
    const state = (window as typeof window & { __flowMotion: {
      list: Element; row: Element; initialListWidth: number;
      initialNameSize: number; initialRowPadding: number;
      samples: { list: number; row: number; nameSize: number; rowPadding: number; editor: number; right: number }[];
      lostList: boolean;
    } }).__flowMotion;
    return {
      initialListWidth: state.initialListWidth,
      initialNameSize: state.initialNameSize,
      initialRowPadding: state.initialRowPadding,
      sameList: document.querySelector('[data-testid="flow-list"]') === state.list,
      sameRow: document.querySelector(`[data-testid="flow-row-${id}"]`) === state.row,
      lostList: state.lostList,
      samples: state.samples,
    };
  }, DEFAULT_WORKFLOW_ID);
  expect(motion.lostList).toBe(false);
  expect(motion.sameList).toBe(true);
  expect(motion.sameRow).toBe(true);
  expect(motion.samples.length).toBeGreaterThan(5);
  const first = motion.samples[0];
  const last = motion.samples[motion.samples.length - 1];
  const between = motion.samples.find((frame) =>
    frame.list < motion.initialListWidth - 60 && frame.list > last.list + 60 &&
    frame.editor < last.editor - 60 && frame.editor > first.editor + 60);
  expect(motion.initialListWidth).toBeGreaterThan(last.list + 150);
  // The 190px rail includes the list's padding and border.
  expect((await page.getByRole('navigation', { name: 'Workflows' }).boundingBox())?.width).toBeCloseTo(190, 0);
  expect(last.list).toBeGreaterThan(150);
  expect(last.list).toBeLessThanOrEqual(190);
  expect(last.editor).toBeGreaterThan(first.editor + 200);
  expect(between).toBeDefined();
  // A panel-width animation alone still lets row typography snap to its
  // compact appearance. At least one visible row style must interpolate.
  const interpolates = (initial: number, final: number, values: number[]) => {
    if (Math.abs(initial - final) < 2) return false;
    const low = Math.min(initial, final) + 0.5;
    const high = Math.max(initial, final) - 0.5;
    return values.some((value) => value > low && value < high);
  };
  expect(
    interpolates(motion.initialNameSize, last.nameSize, motion.samples.map((frame) => frame.nameSize)) ||
    interpolates(motion.initialRowPadding, last.rowPadding, motion.samples.map((frame) => frame.rowPadding)),
  ).toBe(true);
  for (const frame of [first, between!, last]) expect(frame.right).toBeCloseTo(1440, 0);

  // After the panes finish resizing, the graph should be framed about as it
  // would be if the user pressed Fit View in the settled editor.
  const readZoom = () => page.locator('.react-flow__viewport').evaluate((viewport) =>
    new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a);
  const automaticZoom = await readZoom();
  await page.locator('.react-flow__controls-fitview').click();
  const manuallyFittedZoom = await page.evaluate(async () => {
    const viewport = document.querySelector('.react-flow__viewport')!;
    const started = performance.now();
    let previous = 0;
    let stableFrames = 0;
    while (performance.now() - started < 1_000) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
      stableFrames = Math.abs(zoom - previous) < 0.001 ? stableFrames + 1 : 0;
      previous = zoom;
      if (performance.now() - started > 250 && stableFrames >= 8) break;
    }
    return previous;
  });
  expect(automaticZoom).toBeGreaterThan(0);
  expect(manuallyFittedZoom).toBeGreaterThan(0);
  expect(Math.max(automaticZoom, manuallyFittedZoom) / Math.min(automaticZoom, manuallyFittedZoom)).toBeLessThanOrEqual(1.35);

  await page.getByTestId(`flow-row-${crashFlowId}`).click();
  await expect(page).toHaveURL(new RegExp(`/${crashFlowId}$`));
  await expect(page.getByTestId('workflow-title')).toContainText('E2E Crash Recovery');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/${crashFlowId}$`));
  await page.getByRole('link', { name: 'All flows' }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('[data-testid="flow-list"]') ===
    (window as typeof window & { __flowMotion?: { list: Element } }).__flowMotion?.list)).toBe(true);
});

test('direct visits and refreshes open without the entrance animation; reduced motion disables it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
  const shell = page.locator('.console-shell');
  await expect(shell).toHaveAttribute('data-view', 'workspace');
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  expect((await page.getByRole('navigation', { name: 'Workflows' }).boundingBox())?.width).toBeCloseTo(190, 0);
  await expect(shell).not.toHaveAttribute('data-transitioning', 'true');
  await page.reload();
  await expect(shell).toHaveAttribute('data-view', 'workspace');
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  expect((await page.getByRole('navigation', { name: 'Workflows' }).boundingBox())?.width).toBeCloseTo(190, 0);
  await expect(shell).not.toHaveAttribute('data-transitioning', 'true');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`).click();
  await expect(shell).toHaveAttribute('data-view', 'workspace');
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await expect(shell).not.toHaveAttribute('data-transitioning', 'true');
  expect((await page.getByRole('navigation', { name: 'Workflows' }).boundingBox())?.width).toBeCloseTo(190, 0);
});

test('a slow open keeps the same home list until a failed load is shown', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  let fail = true;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/workflows/${DEFAULT_WORKFLOW_ID}`, async (route) => {
    if (fail) {
      await pending;
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    } else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByTestId('flow-list')).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __homeFlowList?: Element }).__homeFlowList = document.querySelector('[data-testid="flow-list"]')!;
  });
  try {
    await page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`).click();
    await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
    await expect(page.locator('.console-shell')).toHaveAttribute('data-view', 'home');
    await expect(page.getByTestId('flow-list')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('[data-testid="flow-list"]') ===
      (window as typeof window & { __homeFlowList?: Element }).__homeFlowList)).toBe(true);
  } finally {
    release();
  }
  await expect(page.getByTestId('flow-load-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect.poll(async () => (await page.getByRole('navigation', { name: 'Workflows' }).boundingBox())?.width).toBeCloseTo(190, 0);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await expect(page.locator('.console-shell')).toHaveAttribute('data-view', 'workspace');
  expect((await page.getByRole('navigation', { name: 'Workflows' }).boundingBox())?.width).toBeCloseTo(190, 0);
});

test('mobile Flows drawer supports keyboard dismissal and switching workflows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Flows', exact: true });
  const switcher = page.getByRole('navigation', { name: 'Workflows' });
  await expect(trigger).toBeVisible();
  await expect(switcher).toBeHidden();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Flows' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(switcher).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.workflow-editor > header.top-bar')).toHaveAttribute('inert', '');
  await expect(page.locator('.console-editor-pane')).toHaveAttribute('inert', '');
  const close = dialog.getByRole('button', { name: 'Close flows' });
  const lastFlow = switcher.locator('a[href]').last();
  await expect(lastFlow).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastFlow).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(switcher).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator('.workflow-editor > header.top-bar')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.console-editor-pane')).not.toHaveAttribute('inert', '');

  await trigger.click();
  await page.getByTestId(`flow-row-${crashFlowId}`).click();
  await expect(page).toHaveURL(new RegExp(`/${crashFlowId}$`));
  await expect(page.getByTestId('workflow-title')).toContainText('E2E Crash Recovery');
  await expect(page.getByRole('button', { name: 'Flows', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('direct switch saves a pending field edit without copying it to the next flow', async ({ page }) => {
  const original = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
  const destination = (await (await page.request.get(`/api/workflows/${crashFlowId}`)).json()).workflow;
  const destinationLabel = destination.nodes.find((node: { id: string }) => node.id === 'agent-1').label ?? '';
  const editedLabel = 'Direct switch pending label';
  try {
    await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
    await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
    await page.locator('[data-id="agent-1"]').click();
    await page.getByRole('textbox', { name: 'Display name' }).fill(editedLabel);
    // Navigate before the field's debounce necessarily commits to the store.
    await page.getByTestId(`flow-row-${crashFlowId}`).click();
    await expect(page).toHaveURL(new RegExp(`/${crashFlowId}$`));
    await expect(page.getByTestId('workflow-title')).toContainText('E2E Crash Recovery');
    await page.locator('[data-id="agent-1"]').click();
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue(destinationLabel);
    const saved = (await (await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json()).workflow;
    expect(saved.nodes.find((node: { id: string }) => node.id === 'agent-1').label).toBe(editedLabel);
  } finally {
    await page.request.put(`/api/workflows/${DEFAULT_WORKFLOW_ID}`, { data: original });
  }
});

test('a failed save keeps the current workflow selected during a switch attempt', async ({ page }) => {
  await page.goto(`/${DEFAULT_WORKFLOW_ID}`);
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
  await page.route(`**/api/workflows/${DEFAULT_WORKFLOW_ID}`, async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    } else {
      await route.continue();
    }
  });
  await page.locator('[data-id="agent-1"]').click();
  await page.getByRole('textbox', { name: 'user message 1' }).fill('Failed switch must keep this edit');
  await expect(page.getByTestId('workflow-title')).toContainText('•');
  await page.getByTestId(`flow-row-${crashFlowId}`).click();
  await expect(page).toHaveURL(new RegExp(`/${DEFAULT_WORKFLOW_ID}$`));
  await expect(page.locator('.workflow-save-error')).toContainText(/Could not save changes/);
  await expect(page.getByTestId(`flow-row-${DEFAULT_WORKFLOW_ID}`)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('workflow-title')).toContainText('•');
});
