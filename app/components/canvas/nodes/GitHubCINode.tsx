'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GitHubCIConfig } from '@/lib/shared/github-ci';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import { ciOutputForNode } from '../../github-ci-details';

export default function GitHubCINode({ id, data, selected }: NodeProps) {
  const output = useWorkflowStore(s => ciOutputForNode(s, id));
  const config = data.config as GitHubCIConfig | undefined;
  return (
    <div
      className="wf-node"
      data-node-type="github-ci"
      data-state={data._state ?? 'idle'}
      data-selected={selected ? 'true' : 'false'}
      aria-label="GitHub CI Gate node"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="wf-node-head">
        <span className="wf-node-title">{String(data.label || 'GITHUB CI GATE')}</span>
      </div>
      <div className="wf-node-body">
        <div>
          {output ? (
            <a href={output.pullRequestUrl} target="_blank" rel="noreferrer" className="nodrag">
              {output.repository} #{output.pullRequest}
            </a>
          ) : `${config?.repository ?? ''} #${config?.pullRequest ?? ''}`}
        </div>
        <div>
          {output?.status ?? 'Pending'} · {output?.passed ?? 0}/{output?.total ?? config?.required.length ?? 0} required
        </div>
        <div>{output?.headSha.slice(0, 7) || 'Awaiting head SHA'}</div>
      </div>
      <Handle type="source" position={Position.Right} id="success" aria-label="CI success" style={{ top: '45%' }} />
      <Handle type="source" position={Position.Right} id="failure" aria-label="CI failure" style={{ top: '80%' }} />
    </div>
  );
}
