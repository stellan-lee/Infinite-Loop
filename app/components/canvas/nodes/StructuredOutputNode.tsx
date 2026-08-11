'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';

const NODE_TYPE = 'structured-output';
const PREVIEW_MAX = 56;

interface StructuredOutputData {
  _state?: string;
  label?: string;
  config?: {
    prompt?: string;
    providerId?: string;
    profile?: string;
  };
}

function truncate(value: string): string {
  return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX - 1)}…` : value;
}

export default function StructuredOutputNode({ data, selected }: NodeProps) {
  const node = (data ?? {}) as StructuredOutputData;
  const state = node._state ?? 'idle';
  const prompt = node.config?.prompt ?? '';
  const preview = truncate(prompt || '(no prompt)');
  const title = node.label?.trim() || 'STRUCTURED OUTPUT';
  const provider = node.config?.providerId || 'no provider';
  const profile = node.config?.profile?.trim();

  return (
    <div
      className="wf-node"
      data-node-type={NODE_TYPE}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      aria-label="structured output node"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="wf-node-head">
        <span className="wf-node-title">{title}</span>
        <span className="wf-node-state-dot" data-state={state} aria-hidden="true" />
      </div>
      <div className="wf-node-body">
        <div>⌘ {profile || provider}</div>
        <div className="wf-node-body-italic" title={preview !== prompt ? prompt : undefined}>
          {preview}
        </div>
      </div>
      <Handle type="source" position={Position.Right} id="next" style={{ top: '40%' }} />
      <Handle type="source" position={Position.Right} id="error" style={{ top: '75%' }} />
    </div>
  );
}
