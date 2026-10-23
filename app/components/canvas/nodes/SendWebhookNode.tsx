'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { type SendWebhookConfig, webhookDestination } from '@/lib/shared/send-webhook';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import { webhookOutputForNode } from '../../send-webhook-details';

export default function SendWebhookNode({ id, data, selected }: NodeProps) {
  const output = useWorkflowStore(state => webhookOutputForNode(state, id));
  const config = data.config as SendWebhookConfig | undefined;
  return (
    <div
      className="wf-node" data-node-type="send-webhook" data-state={data._state ?? 'idle'}
      data-selected={selected ? 'true' : 'false'} aria-label="Send Webhook node"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="wf-node-head">
        <span className="wf-node-title">{String(data.label || 'SEND WEBHOOK')}</span>
      </div>
      <div className="wf-node-body">
        <div>{config?.method ?? 'POST'} · {webhookDestination(config?.url ?? '')}</div>
        <div>{output?.status ?? 'PENDING'}{output?.statusCode ? ` · HTTP ${output.statusCode}` : ''}</div>
      </div>
      <Handle type="source" position={Position.Right} id="success" aria-label="Webhook success" style={{ top: '45%' }} />
      <Handle type="source" position={Position.Right} id="failure" aria-label="Webhook failure" style={{ top: '80%' }} />
    </div>
  );
}
