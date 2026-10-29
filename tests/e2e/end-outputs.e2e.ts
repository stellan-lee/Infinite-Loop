/*
 * Terminal End outputs are a saved run result, independent of later edits to
 * the workflow. Exercise the public run API and the actual history drawer.
 */
import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';
import type { RunRecord, Workflow } from '../../lib/shared/workflow';
import { API_TOKEN, BASE_URL } from './lib/env';

let authCookies: Parameters<BrowserContext['addCookies']>[0];

test.beforeAll(async () => {
  const authContext = await request.newContext({ baseURL: BASE_URL });
  try {
    const auth = await authContext.post('/api/auth', { data: { token: API_TOKEN } });
    expect(auth.ok(), await auth.text()).toBe(true);
    authCookies = (await authContext.storageState()).cookies;
    expect(authCookies.length).toBeGreaterThan(0);
  } finally {
    await authContext.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  await page.context().addCookies(authCookies);
});

function workflow(id: string, outcome: 'succeeded' | 'failed'): Workflow {
  const now = Date.now();
  return {
    id, name: `End outputs ${outcome}`, version: 0,
    createdAt: now, updatedAt: now,
    globals: { topic: 'original result' },
    inputs: [
      { name: 'count', type: 'number' },
      { name: 'approved', type: 'boolean' },
    ],
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'end-1', type: 'end', position: { x: 200, y: 0 },
        config: {
          outcome,
          outputs: {
            topic: 'globals.topic', count: 'inputs.count',
            approved: 'inputs.approved', missing: 'inputs.not_declared',
          },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
  };
}

async function createWorkflow(page: Page, flow: Workflow): Promise<void> {
  const created = await page.request.post('/api/workflows', { data: flow });
  expect(created.ok(), await created.text()).toBe(true);
}

async function startAndReadRecord(page: Page, workflowId: string): Promise<RunRecord> {
  const started = await page.request.post('/api/run', {
    data: { workflowId, inputs: { count: 7, approved: false } },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const { runId } = await started.json() as { runId: string };
  expect(runId).toBeTruthy();

  // The endpoint can serve an in-memory snapshot until the complete history
  // record is persisted; events distinguish the saved record from that view.
  await expect.poll(async () => {
    const response = await page.request.get(`/api/runs/${workflowId}/${runId}`);
    if (!response.ok()) return false;
    const { run } = await response.json() as { run?: Partial<RunRecord> };
    return Array.isArray(run?.events);
  }, { timeout: 30_000 }).toBe(true);
  const response = await page.request.get(`/api/runs/${workflowId}/${runId}`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { run: RunRecord }).run;
}

for (const outcome of ['succeeded', 'failed'] as const) {
  test(`${outcome} End saves typed final outputs and history shows the saved result`, async ({ page }) => {
  const id = `end-outputs-${outcome}-${Date.now()}`;
  const flow = workflow(id, outcome);
  await createWorkflow(page, flow);
  try {
    const record = await startAndReadRecord(page, id);
    const expected = {
      topic: 'original result', count: 7, approved: false, missing: null,
    };
    expect(record.status).toBe(outcome);
    expect(record.finalOutputs).toEqual(expected);
    expect(record.scope['end-1']).toEqual(expected);
    expect(record.events.find(event => event.type === 'run_finished')).toMatchObject({
      status: outcome,
      finalOutputs: expected,
    });

    // Change the live definition after the run. History must still show what
    // the original run produced, not resolve against today's End bindings.
    const changed: Workflow = {
      ...flow,
      globals: { topic: 'changed result' },
      nodes: flow.nodes.map(node => node.type === 'end'
        ? { ...node, config: { outcome, outputs: { replacement: 'globals.topic' } } }
        : node),
    };
    const saved = await page.request.put(`/api/workflows/${id}`, { data: changed });
    expect(saved.ok(), await saved.text()).toBe(true);

    await page.goto('/');
    const row = page.getByTestId(`job-row-${record.runId}`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: `View run ${record.runId}` }).click();
    const drawer = page.getByRole('dialog', { name: 'Run history detail' });
    const finalOutput = drawer.getByRole('region', { name: 'Final output' });
    await expect(finalOutput).toBeVisible();
    await expect(finalOutput).toContainText('original result');
    await expect(finalOutput).toContainText('count');
    await expect(finalOutput).toContainText('7');
    await expect(finalOutput).toContainText('approved');
    await expect(finalOutput).toContainText('false');
    await expect(finalOutput).toContainText('missing');
    await expect(finalOutput).toContainText('null');
    await expect(finalOutput).not.toContainText('replacement');
    await expect(finalOutput).not.toContainText('changed result');

    if (outcome === 'succeeded') {
      await page.goto(`/${id}`);
      await page.getByRole('button', { name: 'toggle run history' }).click();
      await page.getByRole('button', { name: `run ${record.runId}` }).click();
      const historyOutput = page.getByLabel('run history detail')
        .getByRole('region', { name: 'Final output' });
      await expect(historyOutput).toContainText('original result');
      await expect(historyOutput).not.toContainText('changed result');
    }
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
  });
}

test('a failure before End has no final output in its record or detail', async ({ page }) => {
  const id = `end-outputs-early-${Date.now()}`;
  const flow = workflow(id, 'failed');
  flow.inputs = [];
  flow.nodes.splice(1, 0, {
    id: 'script-1', type: 'script', position: { x: 100, y: 0 },
    config: {
      language: 'ts', inputs: {}, outputs: [],
      code: 'function run() { throw new Error("stopped before End"); }',
    },
  });
  flow.edges = [
    { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'script-1' },
    { id: 'e2', source: 'script-1', sourceHandle: 'next', target: 'end-1' },
  ];
  await createWorkflow(page, flow);
  try {
    const started = await page.request.post('/api/run', { data: { workflowId: id } });
    expect(started.ok(), await started.text()).toBe(true);
    const { runId } = await started.json() as { runId: string };
    await expect.poll(async () => {
      const response = await page.request.get(`/api/runs/${id}/${runId}`);
      if (!response.ok()) return null;
      const { run } = await response.json() as { run?: Partial<RunRecord> };
      return Array.isArray(run?.events) ? run : null;
    }, { timeout: 30_000 }).not.toBeNull();
    const response = await page.request.get(`/api/runs/${id}/${runId}`);
    const { run } = await response.json() as { run: RunRecord };
    expect(run.status).toBe('failed');
    expect(run.finalOutputs).toBeUndefined();
    expect(run.events.some(event => event.type === 'node_finished' && event.nodeType === 'end')).toBe(false);

    await page.goto('/');
    await page.getByTestId(`job-row-${runId}`).getByRole('button', { name: `View run ${runId}` }).click();
    await expect(page.getByRole('dialog', { name: 'Run history detail' })
      .getByRole('region', { name: 'Final output' })).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});

test('large historical Final output expands while the event log stays reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = `end-outputs-large-${Date.now()}`;
  const flow = workflow(id, 'succeeded');
  const longValue = Array.from({ length: 100 }, (_, index) => `line ${index}: ${'x'.repeat(60)}`).join('\n');
  flow.inputs = [];
  flow.globals = { longValue };
  flow.nodes = flow.nodes.map(node => node.type === 'end'
    ? {
        ...node,
        config: {
          outcome: 'succeeded',
          outputs: Object.fromEntries(Array.from({ length: 18 }, (_, index) => [
            `value_${index}`, 'globals.longValue',
          ])),
        },
      }
    : node);
  await createWorkflow(page, flow);
  try {
    const record = await startAndReadRecord(page, id);
    expect(record.status).toBe('succeeded');
    expect(Object.keys(record.finalOutputs ?? {})).toHaveLength(18);

    await page.goto('/');
    await page.getByTestId(`job-row-${record.runId}`)
      .getByRole('button', { name: `View run ${record.runId}` }).click();
    const drawer = page.getByRole('dialog', { name: 'Run history detail' });
    const finalOutput = drawer.getByRole('region', { name: 'Final output' });
    await expect(finalOutput).toBeVisible();
    await finalOutput.getByRole('button', { name: 'show more' }).first().click();
    await expect(finalOutput.getByRole('button', { name: 'show less' })).toHaveCount(1);

    const log = drawer.getByLabel('event log');
    const content = log.locator('..');
    const dimensions = await content.evaluate(element => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight + 10);

    // The output starts near the top. A long expansion must remain readable,
    // and scrolling the same drawer must still reveal the final event row.
    await finalOutput.getByText('Final output').scrollIntoViewIfNeeded();
    const contentBounds = (await content.boundingBox())!;
    const headingBounds = (await finalOutput.getByText('Final output').boundingBox())!;
    expect(headingBounds.y).toBeGreaterThanOrEqual(contentBounds.y - 1);
    expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(contentBounds.y + contentBounds.height + 1);
    await page.screenshot({ path: testInfo.outputPath('final-output-history.png'), fullPage: false });

    const lastEvent = log.locator('.run-view-log-row').last();
    await lastEvent.scrollIntoViewIfNeeded();
    await expect(lastEvent).toBeInViewport();
    const logBounds = (await log.boundingBox())!;
    expect(logBounds.y + logBounds.height).toBeGreaterThan(contentBounds.y);
    const lastBounds = (await lastEvent.boundingBox())!;
    expect(lastBounds.y).toBeGreaterThanOrEqual(contentBounds.y - 1);
    expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(contentBounds.y + contentBounds.height + 1);
    await expect(log).toContainText('run_finished');

    await page.goto(`/${id}`);
    await page.getByRole('button', { name: 'toggle run history' }).click();
    await page.getByRole('button', { name: `run ${record.runId}` }).click();
    const editorDetail = page.getByLabel('run history detail');
    const editorOutput = editorDetail.getByRole('region', { name: 'Final output' });
    await expect(editorOutput).toBeVisible();
    await editorOutput.getByRole('button', { name: 'show more' }).first().click();
    await expect(editorOutput.getByRole('button', { name: 'show less' })).toHaveCount(1);
    const editorContent = editorDetail.locator('.run-history-detail-content');
    const editorDimensions = await editorContent.evaluate(element => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(editorDimensions.scrollHeight).toBeGreaterThan(editorDimensions.clientHeight + 10);

    await editorOutput.getByText('Final output').scrollIntoViewIfNeeded();
    const editorBounds = (await editorContent.boundingBox())!;
    const editorHeadingBounds = (await editorOutput.getByText('Final output').boundingBox())!;
    expect(editorHeadingBounds.y).toBeGreaterThanOrEqual(editorBounds.y - 1);
    expect(editorHeadingBounds.y + editorHeadingBounds.height).toBeLessThanOrEqual(editorBounds.y + editorBounds.height + 1);
    await page.screenshot({ path: testInfo.outputPath('final-output-history-editor.png'), fullPage: false });

    const editorLog = editorDetail.getByLabel('event log');
    const editorLastEvent = editorLog.locator('.run-view-log-row').last();
    await editorLastEvent.scrollIntoViewIfNeeded();
    await expect(editorLastEvent).toBeInViewport();
    const editorLastBounds = (await editorLastEvent.boundingBox())!;
    expect(editorLastBounds.y).toBeGreaterThanOrEqual(editorBounds.y - 1);
    expect(editorLastBounds.y + editorLastBounds.height).toBeLessThanOrEqual(editorBounds.y + editorBounds.height + 1);
    await expect(editorLog).toContainText('run_finished');
  } finally {
    await page.request.delete(`/api/workflows/${id}`);
  }
});
