/** Issue #50 acceptance: real production server, HTTP, browser SSE, and hard restart. */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { GitHubCIOutput } from '../../lib/shared/github-ci';
import type { GitHubFixture } from './fixtures/github-ci-preload';
import { API_TOKEN, DEFAULT_WORKFLOW_ID, REPO_ROOT, TMP_DIR, serverEnv } from './lib/env';
import { waitForExit, waitForHealth, type ServerHandle } from './lib/server';

const PORT = 3462;
const REPOSITORY = 'e2e-fixture/ci-gate';
const SECRET = 'e2e-github-signing-fixture-not-a-real-secret';
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const CHECK_URL = `https://github.com/${REPOSITORY}/runs/101`;
const WORKFLOW_URL = `https://github.com/${REPOSITORY}/actions/runs/201`;
const AUTH = { Authorization: `Bearer ${API_TOKEN}` };

interface RunEvent {
  type: string;
  runId?: string;
  nodeId?: string;
  branch?: string;
  output?: GitHubCIOutput;
  outputs?: Record<string, unknown>;
}
interface ProbeWindow extends Window {
  __githubCIEvents: RunEvent[];
  __githubCISource: EventSource;
}
interface RunResult {
  runId: string;
  status: string;
  events?: RunEvent[];
  scope?: Record<string, unknown>;
}

function snapshot(headSha = OLD_SHA): GitHubFixture {
  return {
    repository: REPOSITORY, pullRequest: 17, headSha,
    checks: [{ id: 101, name: 'lint', head_sha: headSha, app: { id: 1 }, status: 'queued', conclusion: null, html_url: CHECK_URL, output: { summary: '' } }],
    workflows: [{ id: 201, workflow_id: 2, run_attempt: 1, name: 'Build', head_sha: headSha, status: 'queued', conclusion: null, html_url: WORKFLOW_URL }],
  };
}

function complete(fixture: GitHubFixture): void {
  for (const record of [...fixture.checks, ...fixture.workflows]) {
    record.status = 'completed';
    record.conclusion = 'success';
  }
}

class Harness {
  readonly root: string;
  readonly data: string;
  readonly fixturePath: string;
  readonly counter: string;
  readonly servers: ServerHandle[] = [];
  server!: ServerHandle;

  constructor(info: TestInfo, timeoutMs = 90_000, withFailureEdge = true) {
    this.root = path.join(TMP_DIR, `github-ci-${info.testId.replace(/[^a-z0-9]/gi, '-')}-${info.retry}`);
    this.data = path.join(this.root, 'data');
    this.fixturePath = path.join(this.root, 'github.json');
    this.counter = path.join(this.root, 'upstream-count.txt');
    for (const sub of ['workflows', 'triggers', 'pids', 'active-runs', 'audit']) mkdirSync(path.join(this.data, sub), { recursive: true });
    mkdirSync(path.join(this.root, 'providers'), { recursive: true });
    writeFileSync(this.counter, '');
    this.write(snapshot());
    writeFileSync(path.join(this.data, 'workflows', `${DEFAULT_WORKFLOW_ID}.json`), JSON.stringify({
      id: DEFAULT_WORKFLOW_ID, name: 'GitHub CI acceptance', version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'upstream', type: 'script', position: { x: 200, y: 0 }, config: {
          language: 'ts', inputs: { counter: this.counter }, outputs: ['repository', 'pullRequest'], cwd: this.root, timeoutMs: 10_000,
          code: `import { appendFileSync } from 'node:fs';\nfunction run(counter) { appendFileSync(counter, 'executed\\n'); return { repository: '${REPOSITORY}', pullRequest: '17' }; }`,
        } },
        { id: 'ci-gate', type: 'github-ci', position: { x: 480, y: 0 }, config: {
          repository: '{{upstream.repository}}', pullRequest: '{{upstream.pullRequest}}',
          required: [{ kind: 'check', name: 'lint' }, { kind: 'workflow', name: 'Build' }], timeoutMs,
        } },
        { id: 'success-end', type: 'end', position: { x: 800, y: -100 }, config: { outcome: 'succeeded' } },
        { id: 'failure-end', type: 'end', position: { x: 800, y: 100 }, config: { outcome: 'failed' } },
      ],
      edges: [
        { id: 'start-upstream', source: 'start', sourceHandle: 'next', target: 'upstream' },
        { id: 'upstream-ci', source: 'upstream', sourceHandle: 'next', target: 'ci-gate' },
        { id: 'ci-success', source: 'ci-gate', sourceHandle: 'success', target: 'success-end' },
        { id: 'ci-failure', source: 'ci-gate', sourceHandle: 'failure', target: 'failure-end' },
      ].filter(edge => withFailureEdge || edge.id !== 'ci-failure'),
    }));
  }

  write(fixture: GitHubFixture): void {
    writeFileSync(`${this.fixturePath}.tmp`, JSON.stringify(fixture));
    renameSync(`${this.fixturePath}.tmp`, this.fixturePath);
  }

  async boot(): Promise<void> {
    const env = serverEnv({
      PORT: String(PORT), INFLOOP_DATA_DIR: this.data, INFLOOP_RUNS_DIR: path.join(this.data, 'runs'),
      INFLOOP_PROVIDERS_DIR: path.join(this.root, 'providers'),
      INFLOOP_GITHUB_TOKEN: 'e2e-github-token-not-a-real-credential', INFLOOP_GITHUB_WEBHOOK_SECRET: SECRET,
      INFLOOP_E2E_GITHUB_FIXTURE: this.fixturePath,
      INFLOOP_E2E_GITHUB_REQUESTS: path.join(this.root, 'github-requests.txt'),
    });
    const proc = spawn('bun', ['--preload', './lib/server/async-local-storage-global.ts', '--preload', './tests/e2e/fixtures/github-ci-preload.ts', 'server.ts'], {
      cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000); };
    proc.stdout?.on('data', capture);
    proc.stderr?.on('data', capture);
    this.server = { proc, port: PORT, baseUrl: `http://127.0.0.1:${PORT}`, output: () => output };
    this.servers.push(this.server);
    await waitForHealth(this.server);
  }

  async stop(): Promise<void> {
    for (const server of this.servers) {
      if (server.proc.exitCode !== null || server.proc.signalCode !== null) continue;
      server.proc.kill('SIGTERM');
      try { await waitForExit(server.proc, 10_000); }
      catch { server.proc.kill('SIGKILL'); await waitForExit(server.proc); }
    }
  }

  async api(route: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.server.baseUrl}${route}`, { ...init, headers: { ...AUTH, 'content-type': 'application/json', ...init.headers } });
  }

  async start(): Promise<string> {
    const res = await this.api('/api/run', { method: 'POST', body: JSON.stringify({ workflowId: DEFAULT_WORKFLOW_ID }) });
    expect(res.status).toBe(202);
    return (await res.json() as { runId: string }).runId;
  }

  async run(runId: string): Promise<RunResult> {
    const res = await this.api(`/api/runs/${DEFAULT_WORKFLOW_ID}/${runId}`);
    expect(res.status).toBe(200);
    return (await res.json() as { run: RunResult }).run;
  }

  async terminal(runId: string, status: string): Promise<RunResult> {
    await expect.poll(async () => (await this.run(runId)).status).toBe(status);
    await expect.poll(async () => (await this.run(runId)).events?.length ?? 0).toBeGreaterThan(0);
    return this.run(runId);
  }

  async webhook(delivery: string, event = 'check_run', payload: object = {}, signatureValid = true): Promise<Response> {
    const body = JSON.stringify({ action: event === 'pull_request' ? 'synchronize' : 'completed', repository: { full_name: REPOSITORY }, ...payload });
    const signature = createHmac('sha256', signatureValid ? SECRET : 'wrong-e2e-secret').update(body).digest('hex');
    return fetch(`${this.server.baseUrl}/api/webhook/github-ci`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${signature}`,
    }, body });
  }

  count(): number { return readFileSync(this.counter, 'utf8').split('\n').filter(Boolean).length; }
}

async function openBrowser(page: Page, harness: Harness): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const auth = await page.request.post(`${harness.server.baseUrl}/api/auth`, { data: { token: API_TOKEN } });
  expect(auth.status()).toBe(200);
  await page.goto(harness.server.baseUrl);
  await expect(page.locator('[data-id="ci-gate"]')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const w = window as unknown as ProbeWindow;
    w.__githubCIEvents = [];
    const source = new EventSource('/api/events');
    w.__githubCISource = source;
    const timeout = setTimeout(() => reject(new Error('CI event stream did not connect')), 10_000);
    source.onmessage = message => {
      const event = JSON.parse(message.data);
      if (event.type === 'state_snapshot') {
        for (const run of event.runs ?? [event.state]) w.__githubCIEvents.push(...(run.events ?? []));
      } else w.__githubCIEvents.push(event);
    };
    source.onopen = () => { clearTimeout(timeout); resolve(); };
  }));
}

async function latestCI(page: Page, runId: string): Promise<GitHubCIOutput | undefined> {
  return page.evaluate(id => (window as unknown as ProbeWindow).__githubCIEvents.filter(event => event.type === 'github_ci_updated' && event.runId === id && event.nodeId === 'ci-gate').at(-1)?.output, runId);
}

async function waitCI(page: Page, runId: string, status: string, headSha = OLD_SHA): Promise<void> {
  await expect.poll(async () => {
    const output = await latestCI(page, runId);
    return { status: output?.status, headSha: output?.headSha };
  }).toEqual({ status, headSha });
}

function gateFinish(run: RunResult): RunEvent {
  const finished = run.events?.filter(event => event.type === 'node_finished' && event.nodeId === 'ci-gate') ?? [];
  expect(finished).toHaveLength(1);
  return finished[0];
}

test.describe('GitHub CI Gate production acceptance', () => {
  let harness: Harness;
  test.beforeEach(async ({}, info) => {
    test.setTimeout(120_000);
    harness = new Harness(info, info.title.includes('deadline') ? 4_000 : 90_000, !info.title.includes('cancelling'));
    await harness.boot();
  });
  test.afterEach(async ({}, info) => {
    if (harness) {
      if (info.status !== info.expectedStatus) await info.attach('github-ci-server.log', { body: harness.servers.map(server => server.output()).join('\n'), contentType: 'text/plain' });
      await harness.stop();
    }
  });

  test('live card and inspector follow the current head; old and duplicate events cannot pass it', async ({ page }, info) => {
    await openBrowser(page, harness);
    const runId = await harness.start();
    await waitCI(page, runId, 'Pending');
    const card = page.locator('[data-id="ci-gate"]');
    await expect(card).toContainText('Pending');
    await expect(card).toContainText('0/2 required');
    await expect(card).toContainText(OLD_SHA.slice(0, 7));
    await expect(card.locator('a')).toHaveAttribute('href', `https://github.com/${REPOSITORY}/pull/17`);
    expect(harness.count()).toBe(1);
    // The initial snapshot has been published, so its REST reads are complete.
    // A quiet waiting gate should not immediately busy-poll GitHub again.
    const requestLog = path.join(harness.root, 'github-requests.txt');
    const idleRequests = readFileSync(requestLog, 'utf8');
    await page.waitForTimeout(350);
    expect(readFileSync(requestLog, 'utf8')).toBe(idleRequests);

    const running = snapshot();
    running.checks[0].status = 'in_progress';
    harness.write(running);
    expect((await harness.webhook('running')).status).toBe(202);
    await waitCI(page, runId, 'Running');
    await expect(card).toContainText('Running');
    await card.locator('.wf-node-title').click();
    const inspector = page.getByRole('region', { name: 'GitHub CI details' });
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(OLD_SHA);
    await expect(inspector).toContainText('check: lint');
    await expect(inspector).toContainText('workflow: Build');

    const current = snapshot(NEW_SHA);
    const old = snapshot();
    complete(old);
    current.checks.push(...old.checks);
    current.workflows.push(...old.workflows);
    harness.write(current);
    expect((await harness.webhook('new-head', 'pull_request', { pull_request: { number: 17, head: { sha: NEW_SHA } } })).status).toBe(202);
    await waitCI(page, runId, 'Pending', NEW_SHA);
    await expect(card).toContainText(NEW_SHA.slice(0, 7));
    await expect(inspector).toContainText(NEW_SHA);
    await inspector.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('pending-ci-inspector.png'), fullPage: true });

    // Both an old success and a duplicate delivery are hints only; REST still
    // says the new head's two explicitly configured requirements are pending.
    const oldPayload = { check_run: { head_sha: OLD_SHA, status: 'completed', conclusion: 'success' } };
    expect((await harness.webhook('old-success', 'check_run', oldPayload)).status).toBe(202);
    expect((await harness.webhook('old-success', 'check_run', oldPayload)).status).toBe(202);
    expect((await harness.api('/api/github-ci/reconcile', { method: 'POST' })).status).toBe(200);
    await waitCI(page, runId, 'Pending', NEW_SHA);
    expect((await harness.run(runId)).status).toBe('running');
    expect((await latestCI(page, runId))?.passed).toBe(0);

    current.checks[0].status = 'completed';
    current.checks[0].conclusion = 'success';
    harness.write(current);
    expect((await harness.webhook('check-only-success')).status).toBe(202);
    await expect.poll(async () => (await latestCI(page, runId))?.passed).toBe(1);
    expect((await harness.run(runId)).status).toBe('running');

    complete(current);
    current.checks.push({
      id: 301, name: 'optional-audit', head_sha: NEW_SHA, app: { id: 3 },
      status: 'completed', conclusion: 'failure', html_url: `https://github.com/${REPOSITORY}/runs/301`,
      output: { summary: 'Optional audit does not belong to the required set' },
    });
    harness.write(current);
    // An out-of-order failure payload must not override the authoritative,
    // current-head successful snapshot returned by GitHub REST.
    expect((await harness.webhook('late-failure', 'workflow_run', { workflow_run: { head_sha: OLD_SHA, conclusion: 'failure' } })).status).toBe(202);
    const run = await harness.terminal(runId, 'succeeded');
    expect(gateFinish(run)).toMatchObject({ branch: 'success', outputs: { status: 'Passed', headSha: NEW_SHA, passed: 2, total: 2 } });
    await expect(card).toContainText('Passed');
    await expect(card).toContainText('2/2 required');
    expect(harness.count()).toBe(1);
    expect((await harness.webhook('late-failure', 'workflow_run')).status).toBe(202);
    expect(gateFinish(await harness.run(runId)).branch).toBe('success');
  });

  test('signed failures take the failure branch with actionable names, summary and logs', async ({ page }, info) => {
    await openBrowser(page, harness);
    const runId = await harness.start();
    await waitCI(page, runId, 'Pending');
    const failed = snapshot();
    complete(failed);
    failed.checks[0].conclusion = 'failure';
    failed.checks[0].output.summary = 'src/example.ts:12: lint rule no-unused-vars failed';
    harness.write(failed);

    expect((await harness.webhook('forged-failure', 'check_run', {}, false)).status).toBe(401);
    expect((await fetch(`${harness.server.baseUrl}/api/github-ci/reconcile`, { method: 'POST' })).status).toBe(401);
    expect((await harness.run(runId)).status).toBe('running');
    expect((await harness.webhook('signed-failure')).status).toBe(202);
    const run = await harness.terminal(runId, 'failed');
    expect(gateFinish(run)).toMatchObject({ branch: 'failure', outputs: { status: 'Failed', headSha: OLD_SHA, failed: ['check:lint'] } });
    const output = gateFinish(run).outputs as unknown as GitHubCIOutput;
    expect(output.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'lint', conclusion: 'failure', url: CHECK_URL, summary: failed.checks[0].output.summary })]));
    const card = page.locator('[data-id="ci-gate"]');
    await expect(card).toContainText('Failed');
    await card.locator('.wf-node-title').click();
    await expect(page.getByText(failed.checks[0].output.summary, { exact: true })).toBeVisible();
    await expect(page.locator(`a[href="${CHECK_URL}"]`).first()).toBeVisible();
    await page.getByRole('region', { name: 'GitHub CI details' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('failed-ci-inspector.png'), fullPage: true });
  });

  test('SIGKILL while waiting resumes the same run and never replays the upstream script', async ({ page }) => {
    await openBrowser(page, harness);
    const runId = await harness.start();
    await waitCI(page, runId, 'Pending');
    expect(harness.count()).toBe(1);
    harness.server.proc.kill('SIGKILL');
    await waitForExit(harness.server.proc);
    await harness.boot();
    await openBrowser(page, harness);
    expect((await harness.run(runId)).runId).toBe(runId);
    expect((await harness.run(runId)).status).toBe('running');
    expect(harness.count()).toBe(1);
    const success = snapshot();
    complete(success);
    harness.write(success);
    expect((await harness.webhook('after-restart')).status).toBe(202);
    const run = await harness.terminal(runId, 'succeeded');
    expect(run.runId).toBe(runId);
    expect(gateFinish(run)).toMatchObject({ branch: 'success', outputs: { status: 'Passed', headSha: OLD_SHA } });
    expect(harness.count()).toBe(1);
    const history = await (await harness.api(`/api/runs?workflowId=${DEFAULT_WORKFLOW_ID}`)).json() as { runs: Array<{ runId: string }> };
    expect(history.runs.map(item => item.runId)).toEqual([runId]);
  });

  test('deadline expiry is nonpassing and follows the failure branch', async ({ page }) => {
    await openBrowser(page, harness);
    const runId = await harness.start();
    await waitCI(page, runId, 'Pending');
    const run = await harness.terminal(runId, 'failed');
    expect(gateFinish(run)).toMatchObject({ branch: 'failure', outputs: { status: 'Error', headSha: OLD_SHA } });
    expect(gateFinish(run).outputs?.errorMessage).toMatch(/timed out/i);
    expect(run.events?.some(event => event.type === 'node_started' && event.nodeId === 'success-end')).toBe(false);
  });

  test('cancelling a waiting run with no failure edge cannot release the success branch', async ({ page }) => {
    await openBrowser(page, harness);
    const runId = await harness.start();
    await waitCI(page, runId, 'Pending');
    expect((await harness.api(`/api/run/stop?runId=${runId}`, { method: 'POST' })).status).toBe(200);
    const run = await harness.terminal(runId, 'cancelled');
    expect(run.events?.some(event => event.type === 'node_started' && event.nodeId === 'success-end')).toBe(false);
    expect(run.events?.filter(event => event.type === 'github_ci_updated').at(-1)?.output?.status).toBe('Cancelled');
    const success = snapshot();
    complete(success);
    harness.write(success);
    expect((await harness.webhook('success-after-stop')).status).toBe(202);
    expect((await harness.run(runId)).status).toBe('cancelled');
    expect(harness.count()).toBe(1);
  });
});
