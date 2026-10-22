'use client';

import type { WorkflowStoreState } from '@/lib/client/workflow-store-client';
import type { WorkflowEvent } from '@/lib/shared/workflow';
import type { GitHubCIOutput } from '@/lib/shared/github-ci';

export function latestCIOutput(events: readonly WorkflowEvent[], nodeId: string): GitHubCIOutput | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'github_ci_updated' && event.nodeId === nodeId) return event.output;
  }
}

/** Historical inspection uses its event set; live views use durable snapshot state. */
export function ciOutputForNode(
  state: Pick<WorkflowStoreState, 'inspectedRunEvents' | 'runEvents' | 'githubCI'>,
  nodeId: string,
): GitHubCIOutput | undefined {
  if (state.inspectedRunEvents !== null) return latestCIOutput(state.inspectedRunEvents, nodeId);
  return state.githubCI[nodeId] ?? latestCIOutput(state.runEvents, nodeId);
}

export function GitHubCIDetails({ output }: { output?: GitHubCIOutput }) {
  if (!output) {
    return <p className="field-hint">Run this workflow to inspect GitHub CI results.</p>;
  }
  return (
    <section aria-label="GitHub CI details" className="field">
      <h3>{output.status} · {output.passed}/{output.total} required</h3>
      <a href={output.pullRequestUrl} target="_blank" rel="noreferrer">
        {output.repository} #{output.pullRequest}
      </a>
      <p style={{ overflowWrap: 'anywhere' }}>{output.headSha}</p>
      {output.errorMessage && <p role="alert">{output.errorMessage}</p>}
      {output.pending.length > 0 && <p>Pending: {output.pending.join(', ')}</p>}
      <ul className="kv-rows">
        {output.checks.map(check => (
          <li key={`${check.kind}:${check.identity}:${check.id}`} className="field">
            <div>
              <strong>{check.kind}: {check.name}</strong> · {check.required ? 'Required' : 'Optional'}
            </div>
            <div>{check.status} / {check.conclusion ?? 'unknown'} · #{check.id} · attempt {check.attempt}</div>
            {check.summary && <p style={{ whiteSpace: 'pre-wrap' }}>{check.summary}</p>}
            {/^https:\/\//.test(check.url) && (
              <a href={check.url} target="_blank" rel="noreferrer">View GitHub {check.kind}</a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
