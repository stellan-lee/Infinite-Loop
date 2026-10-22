/** Test-only GitHub REST fixture. Loaded before the production server captures fetch. */
import { appendFileSync, readFileSync } from 'node:fs';

export interface GitHubFixture {
  repository: string;
  pullRequest: number;
  headSha: string;
  checks: Array<{
    id: number;
    name: string;
    head_sha: string;
    app: { id: number };
    status: string;
    conclusion: string | null;
    html_url: string;
    output: { summary: string };
  }>;
  workflows: Array<{
    id: number;
    workflow_id: number;
    run_attempt: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url: string;
  }>;
}

const fixturePath = process.env.INFLOOP_E2E_GITHUB_FIXTURE;
if (!fixturePath) throw new Error('GitHub E2E preload requires a fixture path');
const nativeFetch = globalThis.fetch;
const fixtureFetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const [input, init] = args;
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'https://api.github.com') return nativeFetch(...args);

  // Never fall through to the live GitHub API, including unexpected REST paths.
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method !== 'GET') throw new Error(`Unexpected GitHub fixture method: ${method}`);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GitHubFixture;
  const base = `/repos/${fixture.repository}`;
  if (process.env.INFLOOP_E2E_GITHUB_REQUESTS) {
    appendFileSync(process.env.INFLOOP_E2E_GITHUB_REQUESTS, `${url.pathname}${url.search}\n`);
  }
  if (url.pathname === `${base}/pulls/${fixture.pullRequest}`) {
    return Response.json({ number: fixture.pullRequest, head: { sha: fixture.headSha } });
  }
  const checkMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([a-f0-9]+)\/check-runs$/);
  const page = Number(url.searchParams.get('page') || 1);
  const pageSize = Number(url.searchParams.get('per_page') || 100);
  if (checkMatch && url.pathname.startsWith(`${base}/commits/`)) {
    const checks = fixture.checks.filter(check => check.head_sha === checkMatch[1]);
    return Response.json({ total_count: checks.length, check_runs: checks.slice((page - 1) * pageSize, page * pageSize) });
  }
  if (url.pathname === `${base}/actions/runs`) {
    const workflows = fixture.workflows.filter(run => run.head_sha === url.searchParams.get('head_sha'));
    return Response.json({ total_count: workflows.length, workflow_runs: workflows.slice((page - 1) * pageSize, page * pageSize) });
  }
  throw new Error(`Unexpected GitHub fixture URL: ${url.pathname}`);
};
globalThis.fetch = Object.assign(fixtureFetch, nativeFetch);
