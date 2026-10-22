/** Required identities deliberately distinguish a check from an Actions workflow. */
export interface GitHubCIRequirement {
  kind: 'check' | 'workflow';
  name: string;
}
export interface GitHubCIConfig {
  repository: string;
  pullRequest: string;
  required: GitHubCIRequirement[];
  timeoutMs: number;
}
export type GitHubCIStatus = 'Pending' | 'Running' | 'Passed' | 'Failed' | 'Cancelled' | 'Error';
export interface GitHubCIRecord extends GitHubCIRequirement {
  id: number;
  identity: number;
  attempt: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
  summary?: string;
  required: boolean;
}
export interface GitHubCIOutput {
  repository: string;
  pullRequest: number;
  pullRequestUrl: string;
  headSha: string;
  status: GitHubCIStatus;
  required: Array<GitHubCIRequirement & { conclusion: string | null; urls: string[] }>;
  checks: GitHubCIRecord[];
  passed: number;
  total: number;
  failed: string[];
  pending: string[];
  errorMessage?: string;
  updatedAt: number;
}

export function validateGitHubCIConfig(value: unknown, resolved = false): asserts value is GitHubCIConfig {
  const config = value as GitHubCIConfig | undefined;
  if (!config || typeof config.repository !== 'string' || !config.repository.trim() ||
      typeof config.pullRequest !== 'string' || !config.pullRequest.trim()) {
    throw new Error('GitHub CI Gate requires a repository and pull request');
  }
  if (resolved && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
      !/^[1-9]\d*$/.test(config.pullRequest) || !Number.isSafeInteger(Number(config.pullRequest)))) {
    throw new Error('GitHub CI Gate requires owner/repository and a positive PR number');
  }
  if (!Array.isArray(config.required) || config.required.length === 0 ||
      config.required.some(item => !item || !['check', 'workflow'].includes(item.kind) ||
        typeof item.name !== 'string' || !item.name.trim())) {
    throw new Error('GitHub CI Gate requires at least one named check or workflow');
  }
  if (new Set(config.required.map(item => `${item.kind}:${item.name}`)).size !== config.required.length) {
    throw new Error('GitHub CI Gate requirements must be unique');
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647) {
    throw new Error('GitHub CI Gate timeoutMs must be a positive integer up to 2147483647');
  }
}

export function isGitHubCITerminal(status: GitHubCIStatus): boolean {
  return status !== 'Pending' && status !== 'Running';
}
