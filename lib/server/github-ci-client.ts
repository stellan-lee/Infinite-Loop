import type { GitHubCIConfig, GitHubCIOutput, GitHubCIRecord } from '../shared/github-ci';

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/** Only explicit completed/success passes. Missing and unknown conclusions wait. */
export function aggregateCI(config: GitHubCIConfig, headSha: string, records: GitHubCIRecord[]): GitHubCIOutput {
  const latest = new Map<string, GitHubCIRecord>();
  for (const record of records) {
    if (record.headSha !== headSha) continue;
    const key = `${record.kind}:${record.name}:${record.identity}`;
    const previous = latest.get(key);
    if (!previous || record.id > previous.id || (record.id === previous.id && record.attempt > previous.attempt)) {
      latest.set(key, record);
    }
  }
  const checks = [...latest.values()].map(record => ({
    ...record,
    required: config.required.some(item => item.kind === record.kind && item.name === record.name),
  }));
  const failed: string[] = [];
  const pending: string[] = [];
  let status: GitHubCIOutput['status'] = 'Pending';
  let passed = 0;
  const required = config.required.map(item => {
    const matches = checks.filter(record => record.kind === item.kind && record.name === item.name);
    const conclusions = matches.map(record => record.status === 'completed' ? record.conclusion : null);
    const name = `${item.kind}:${item.name}`;
    const failure = conclusions.find(value => value && FAILED_CONCLUSIONS.has(value));
    const unsuccessful = conclusions.find(value => value === 'skipped' || value === 'neutral');
    let conclusion: string | null = null;
    if (failure) {
      failed.push(name);
      status = 'Failed';
      conclusion = failure;
    } else if (conclusions.includes('cancelled')) {
      failed.push(name);
      if (status !== 'Failed') status = 'Cancelled';
      conclusion = 'cancelled';
    } else if (unsuccessful) {
      failed.push(name);
      if (status !== 'Failed' && status !== 'Cancelled') status = 'Error';
      conclusion = unsuccessful;
    } else if (matches.length && conclusions.every(value => value === 'success')) {
      passed++;
      conclusion = 'success';
    } else {
      pending.push(name);
    }
    return { ...item, conclusion, urls: matches.map(record => record.url).filter(Boolean) };
  });
  if (!failed.length) {
    if (required.length && passed === required.length) status = 'Passed';
    else if (checks.some(record => record.required && record.status === 'in_progress')) status = 'Running';
  }
  return {
    repository: config.repository,
    pullRequest: Number(config.pullRequest),
    pullRequestUrl: `https://github.com/${config.repository}/pull/${config.pullRequest}`,
    headSha, status, required, checks, passed, total: required.length, failed, pending,
    updatedAt: Date.now(),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub API object');
  return value as Record<string, unknown>;
}

function normalizeRecord(value: unknown, kind: GitHubCIRecord['kind']): GitHubCIRecord {
  const record = object(value);
  const identity = kind === 'check' ? object(record.app).id : record.workflow_id;
  const attempt = kind === 'check' ? 1 : record.run_attempt;
  if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0 ||
      !Number.isSafeInteger(identity) || Number(identity) <= 0 ||
      !Number.isSafeInteger(attempt) || Number(attempt) <= 0 ||
      typeof record.name !== 'string' || typeof record.status !== 'string' ||
      typeof record.head_sha !== 'string' ||
      (record.conclusion !== null && typeof record.conclusion !== 'string')) {
    throw new Error('GitHub CI identity or result is missing or invalid');
  }
  const url = record.html_url ?? record.details_url;
  const summary = record.output ? object(record.output).summary : undefined;
  return {
    kind,
    id: record.id as number,
    identity: identity as number,
    attempt: attempt as number,
    name: record.name,
    headSha: record.head_sha,
    status: record.status,
    conclusion: record.conclusion as string | null,
    url: typeof url === 'string' && /^https:\/\//.test(url) ? url : '',
    summary: typeof summary === 'string' ? summary.slice(0, 4000) : undefined,
    required: false,
  };
}

export class GitHubCIClient {
  constructor(private request: typeof fetch = fetch) {}

  private async get(path: string): Promise<Record<string, unknown>> {
    const token = process.env.INFLOOP_GITHUB_TOKEN;
    if (!token) throw new Error('INFLOOP_GITHUB_TOKEN is required for GitHub CI');
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new Error('GitHub API request failed or timed out');
    }
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    try { return object(await response.json()); }
    catch { throw new Error('Invalid GitHub API response'); }
  }

  async head(repository: string, pr: string): Promise<string> {
    const body = await this.get(`/repos/${repository}/pulls/${pr}`);
    const sha = object(body.head).sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha)) {
      throw new Error('GitHub PR response has no valid head SHA');
    }
    return sha;
  }

  private async list(path: string, key: string): Promise<unknown[]> {
    const results: unknown[] = [];
    const ids = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const body = await this.get(`${path}&per_page=100&page=${page}`);
      const items = body[key];
      if (!Array.isArray(items) || !Number.isSafeInteger(body.total_count) || Number(body.total_count) < 0) {
        throw new Error('Invalid GitHub CI list response');
      }
      if (Number(body.total_count) >= 1000) {
        throw new Error('GitHub CI result limit reached; completeness cannot be verified');
      }
      for (const item of items) {
        const id = object(item).id;
        if (!Number.isSafeInteger(id) || ids.has(id as number)) throw new Error('GitHub CI pagination is inconsistent');
        ids.add(id as number);
      }
      results.push(...items);
      if (results.length === body.total_count) return results;
      if (!items.length || results.length > Number(body.total_count)) throw new Error('Incomplete GitHub CI pagination');
    }
    throw new Error('GitHub CI pagination limit exceeded');
  }

  async reconcile(config: GitHubCIConfig): Promise<GitHubCIOutput> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await this.head(config.repository, config.pullRequest);
      const base = `/repos/${config.repository}`;
      const [checks, workflows] = await Promise.all([
        this.list(`${base}/commits/${head}/check-runs?filter=all`, 'check_runs'),
        this.list(`${base}/actions/runs?head_sha=${head}`, 'workflow_runs'),
      ]);
      const records = [
        ...checks.map(record => normalizeRecord(record, 'check')),
        ...workflows.map(record => normalizeRecord(record, 'workflow')),
      ];
      const result = aggregateCI(config, head, records);
      // Never publish a terminal result (or stale pending snapshot) for an old head.
      if (await this.head(config.repository, config.pullRequest) === head) return result;
    }
    throw new Error('PR head changed repeatedly during CI reconciliation');
  }
}
