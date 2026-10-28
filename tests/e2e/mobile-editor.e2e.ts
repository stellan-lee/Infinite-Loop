import { expect, test, type Locator, type Page } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID } from './lib/env';

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
});

async function openEditor(page: Page, flowId = DEFAULT_WORKFLOW_ID): Promise<void> {
  await page.goto(`/${flowId}`);
  await expect(page.locator('[data-id="agent-1"]')).toBeVisible();
}

async function createDisposableCopy(page: Page): Promise<string> {
  const source = await page.request.get(`/api/workflows/${DEFAULT_WORKFLOW_ID}`);
  expect(source.ok()).toBe(true);
  const { workflow } = await source.json();
  const id = `mobile-editor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const created = await page.request.post('/api/workflows', {
    data: { ...workflow, id, name: 'Mobile editor E2E', createdAt: now, updatedAt: now },
  });
  expect(created.ok()).toBe(true);
  return id;
}

async function expectWithinViewport(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, 'visible target has a bounding box').not.toBeNull();
  const size = page.viewportSize()!;
  expect(box!.x, 'left edge is visible').toBeGreaterThanOrEqual(-1);
  expect(box!.y, 'top edge is visible').toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, 'right edge is visible').toBeLessThanOrEqual(size.width + 1);
  expect(box!.y + box!.height, 'bottom edge is visible').toBeLessThanOrEqual(size.height + 1);
}

async function expectEditorFits(page: Page): Promise<void> {
  const header = page.locator('header.top-bar');
  const canvas = page.locator('.canvas-shell');
  await expectWithinViewport(page, header);
  await expectWithinViewport(page, canvas);
  const headerBox = (await header.boundingBox())!;
  const canvasBox = (await canvas.boundingBox())!;
  expect(canvasBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  expect(canvasBox.height).toBeGreaterThanOrEqual(120);
  expect(canvasBox.width).toBeGreaterThanOrEqual(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const control of await header.locator('a, button').all()) {
    if (!await control.isVisible()) continue;
    // The action row may scroll horizontally on narrow phones. Every control
    // must be reachable without scrolling the document or clipping vertically.
    await control.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, control);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

async function expectGraphFitsCanvas(page: Page): Promise<void> {
  const canvas = page.locator('.canvas-shell');
  for (const id of ['start-1', 'agent-1', 'end-1']) {
    await expect.poll(async () => {
      const pane = await canvas.boundingBox();
      const node = await page.locator(`[data-id="${id}"]`).boundingBox();
      if (!pane || !node) return false;
      return node.x >= pane.x - 1 && node.x + node.width <= pane.x + pane.width + 1
        && node.y >= pane.y - 1 && node.y + node.height <= pane.y + pane.height + 1;
    }, { message: `${id} fits within the mobile canvas` }).toBe(true);
  }
}

test('mobile toolbar and canvas remain usable across portrait and landscape widths', async ({ page }, info) => {
  for (const size of [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await openEditor(page);
    if (size.width === 390 || size.width === 844) {
      await page.screenshot({ path: info.outputPath(`mobile-editor-${size.width}x${size.height}.png`), fullPage: false });
    }
    await expectEditorFits(page);
    if (size.width === 390) {
      await expectGraphFitsCanvas(page);
      await page.locator('.workflow-editor .actions').evaluate((element) => { element.scrollLeft = 0; });
      await page.screenshot({ path: info.outputPath('mobile-editor-graph-settled-390x844.png'), fullPage: false });
    }
    await expect(page.getByRole('link', { name: 'Inf·Loop home' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'toggle run history' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'run workflow' })).toBeVisible();
  }
});

test('mobile node palette scrolls within the editor and tapping a node adds it', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const flowId = await createDisposableCopy(page);
  try {
    await openEditor(page, flowId);
    const palette = page.getByRole('complementary', { name: 'palette' });
    const toggle = page.getByRole('button', { name: 'Nodes', exact: true });
    await expect(toggle).toBeVisible();
    await expect(palette).toBeHidden();
    await toggle.click();
    await expect(palette).toBeVisible();
    await expectWithinViewport(page, palette);
    await page.screenshot({ path: info.outputPath('mobile-editor-nodes-open-390x844.png'), fullPage: false });
    const scroll = await palette.evaluate((element) => ({
      height: element.clientHeight, contentHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(scroll.contentHeight).toBeGreaterThan(scroll.height);
    expect(scroll.overflowY).toMatch(/auto|scroll/);
    await palette.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await palette.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(palette.getByRole('button', { name: 'add script node' })).toBeVisible();
    const oldNodeCount = await page.locator('.react-flow__node').count();
    await palette.getByRole('button', { name: 'add script node' }).tap();
    await expect(page.locator('.react-flow__node')).toHaveCount(oldNodeCount + 1);
    await expectEditorFits(page);
    await expect(palette).toBeHidden();
    await toggle.click();
    await page.getByRole('button', { name: 'Close nodes' }).click();
    await expect(palette).toBeHidden();
    await page.getByRole('link', { name: 'Inf·Loop home' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/?$/);
  } finally {
    await page.request.delete(`/api/workflows/${flowId}`);
  }
});

test('mobile inspector and history remain reachable; desktop keeps its palette', async ({ page }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await openEditor(page);

    await page.locator('[data-id="agent-1"]').tap();
    const inspector = page.locator('.node-inspector');
    await expect(inspector).toBeVisible();
    await expectWithinViewport(page, inspector);
    await expectWithinViewport(page, page.getByRole('button', { name: 'close node inspector' }));
    await page.getByRole('button', { name: 'close node inspector' }).click();
    await expect(inspector).toHaveCount(0);

    await page.getByRole('button', { name: 'toggle run history' }).click();
    const history = page.locator('.run-view');
    await expect(history).toBeVisible();
    await expectWithinViewport(page, history);
    await expectEditorFits(page);
    await page.getByRole('button', { name: 'toggle run history' }).click();
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('complementary', { name: 'palette' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nodes', exact: true })).toBeHidden();
  await expect(page.locator('.canvas-shell')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
