import { describe, expect, test } from 'bun:test';
import { aggregateCI, GitHubCIClient } from './github-ci-client';
import { validateGitHubCIConfig, type GitHubCIConfig, type GitHubCIRecord } from '../shared/github-ci';

const sha = 'a'.repeat(40);
const config: GitHubCIConfig = { repository: 'owner/repo', pullRequest: '12', required: [{ kind: 'check', name: 'test' }, { kind: 'workflow', name: 'build' }], timeoutMs: 60_000 };
function record(patch: Partial<GitHubCIRecord> = {}): GitHubCIRecord {
  return { id: 1, identity: 10, attempt: 1, name: 'test', kind: 'check', headSha: sha, status: 'completed', conclusion: 'success', url: 'https://github.com/owner/repo/checks/1', required: false, ...patch };
}
const workflow = () => record({ kind: 'workflow', name: 'build', identity: 20 });

describe('GitHub CI aggregate', () => {
  test('requires every distinct configured identity; optional failure does not block', () => {
    const output = aggregateCI(config, sha, [record(), workflow(), record({ name: 'optional', conclusion: 'failure' })]);
    expect(output.status).toBe('Passed');
    expect(output.passed).toBe(2);
    expect(output.checks.find(r => r.name === 'optional')?.required).toBe(false);
  });
  test('concurrent required checks and missing workflow remain incomplete', () => {
    const output = aggregateCI(config, sha, [record({ status: 'in_progress', conclusion: null })]);
    expect(output.status).toBe('Running');
    expect(output.pending).toEqual(['check:test', 'workflow:build']);
  });
  test('check and workflow names do not alias', () => {
    const output = aggregateCI({ ...config, required: [{ kind: 'workflow', name: 'test' }] }, sha, [record()]);
    expect(output.status).toBe('Pending');
  });
  test('newer reruns and all same-name providers supersede old successes', () => {
    expect(aggregateCI(config, sha, [record(), record({ id: 2, status: 'queued', conclusion: null }), workflow()]).status).toBe('Pending');
    expect(aggregateCI(config, sha, [record(), record({ identity: 11, status: 'in_progress', conclusion: null }), workflow()]).status).toBe('Running');
    expect(aggregateCI(config, sha, [record(), workflow(), { ...workflow(), attempt: 2, status: 'queued', conclusion: null }]).status).toBe('Pending');
  });
  test('old commit results cannot satisfy the current head', () => {
    expect(aggregateCI(config, 'b'.repeat(40), [record(), workflow()]).status).toBe('Pending');
  });
  test.each(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'])('%s is a required failure with links and summary', conclusion => {
    const result = aggregateCI(config, sha, [record({ conclusion, summary: 'tests failed' }), workflow()]);
    expect(result.status).toBe('Failed');
    expect(result.failed).toEqual(['check:test']);
    expect(result.required[0].urls).toEqual([record().url]);
    expect(result.checks[0].summary).toBe('tests failed');
  });
  test.each([['cancelled', 'Cancelled'], ['skipped', 'Error'], ['neutral', 'Error'], ['new_unknown', 'Pending'], [null, 'Pending']] as const)('%s never passes', (conclusion, status) => {
    expect(aggregateCI(config, sha, [record({ conclusion }), workflow()]).status).toBe(status);
  });
  test('empty and duplicate requirements are invalid', () => {
    expect(() => validateGitHubCIConfig({ ...config, required: [] })).toThrow();
    expect(() => validateGitHubCIConfig({ ...config, required: [config.required[0], config.required[0]] })).toThrow();
  });
});

describe('GitHub CI authoritative reconciliation', () => {
  test('paginates exact SHA results and rereads head before returning', async () => {
    const prior = process.env.INFLOOP_GITHUB_TOKEN;
    process.env.INFLOOP_GITHUB_TOKEN = 'local-test-token';
    const urls: string[] = [];
    try {
      const client = new GitHubCIClient((async input => {
        const url = String(input); urls.push(url);
        if (url.includes('/pulls/')) return Response.json({ head: { sha } });
        if (url.includes('/actions/')) return Response.json({ total_count: 0, workflow_runs: [] });
        const page = new URL(url).searchParams.get('page');
        const checks = page === '1' ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, app: { id: 10 }, name: `optional-${index}`, head_sha: sha, status: 'completed', conclusion: 'success' })) : [{ id: 101, app: { id: 10 }, name: 'test', head_sha: sha, status: 'completed', conclusion: 'success' }];
        return Response.json({ total_count: 101, check_runs: checks });
      }) as typeof fetch);
      const output = await client.reconcile({ ...config, required: [config.required[0]] });
      expect(output.status).toBe('Passed');
      expect(urls.filter(url => url.includes('/pulls/'))).toHaveLength(2);
      expect(urls.some(url => url.includes(`${sha}/check-runs?filter=all&per_page=100&page=2`))).toBe(true);
    } finally { if (prior === undefined) delete process.env.INFLOOP_GITHUB_TOKEN; else process.env.INFLOOP_GITHUB_TOKEN = prior; }
  });
  test('head changed during fetch cannot publish old success', async () => {
    const prior = process.env.INFLOOP_GITHUB_TOKEN;
    process.env.INFLOOP_GITHUB_TOKEN = 'local-test-token';
    let heads = 0;
    try {
      const client = new GitHubCIClient((async input => {
        const url = String(input);
        if (url.includes('/pulls/')) return Response.json({ head: { sha: ++heads === 1 ? sha : 'b'.repeat(40) } });
        if (url.includes('/actions/')) return Response.json({ total_count: 0, workflow_runs: [] });
        return Response.json({ total_count: 1, check_runs: [{ id: 1, app: { id: 10 }, name: 'test', head_sha: sha, status: 'completed', conclusion: 'success' }] });
      }) as typeof fetch);
      const output = await client.reconcile({ ...config, required: [config.required[0]] });
      expect(output.headSha).toBe('b'.repeat(40));
      expect(output.status).toBe('Pending');
    } finally { if (prior === undefined) delete process.env.INFLOOP_GITHUB_TOKEN; else process.env.INFLOOP_GITHUB_TOKEN = prior; }
  });
});
