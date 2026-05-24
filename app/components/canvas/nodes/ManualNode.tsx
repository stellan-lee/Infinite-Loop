'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  MANUAL_DEFAULT_DECISIONS,
  type ManualDecisionDecl,
  type ManualDecisionKey,
} from '@/lib/shared/workflow';

const NODE_TYPE = 'manual';
const BRIEF_PREVIEW_MAX = 60;

interface ManualData {
  _state?: string;
  label?: string;
  config?: {
    brief?: string;
    reviewerHint?: string;
    decisions?: ManualDecisionDecl[];
    timeoutMs?: number;
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Vertically stagger N source handles down the right edge so each decision
 *  branch lands on its own line. Mirrors the `top: '40%' / '72%'` style other
 *  nodes use, but parametrized for an arbitrary count. */
function handleTopPct(index: number, total: number): string {
  // Reserve the top of the card for the header; spread handles in the
  // lower 2/3 so they don't overlap the title chip.
  const start = 35;
  const span = 60;
  if (total === 1) return `${start + span / 2}%`;
  const step = span / (total - 1);
  return `${start + step * index}%`;
}

export default function ManualNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as ManualData;
  const state = d._state ?? 'idle';
  const title = d.label?.trim() || 'MANUAL';
  const declared = d.config?.decisions;
  const decisions: ManualDecisionDecl[] =
    declared && declared.length > 0
      ? declared
      : MANUAL_DEFAULT_DECISIONS.map((key) => ({ key }));
  const brief = (d.config?.brief ?? '').trim();
  const briefPreview = brief ? truncate(brief, BRIEF_PREVIEW_MAX) : '';
  const briefTitle = briefPreview !== brief ? brief : undefined;
  const reviewerHint = (d.config?.reviewerHint ?? '').trim();

  return (
    <div
      className="wf-node"
      data-node-type={NODE_TYPE}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      aria-label="manual node"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="wf-node-head">
        <span className="wf-node-title">{title}</span>
        <span
          className="wf-node-state-dot"
          data-state={state}
          aria-hidden="true"
        />
      </div>
      <div className="wf-node-body">
        <div>
          ✋ {decisions.length} decision{decisions.length === 1 ? '' : 's'}
          {reviewerHint ? ` · for ${reviewerHint}` : ''}
        </div>
        <div className="wf-node-body-italic" title={briefTitle}>
          {briefPreview || '(no brief — reviewers will see the bare node)'}
        </div>
      </div>
      {decisions.map((decl, i) => (
        <Handle
          key={decl.key}
          type="source"
          position={Position.Right}
          id={decl.key satisfies ManualDecisionKey}
          aria-label={`decision ${decl.key}`}
          style={{ top: handleTopPct(i, decisions.length) }}
        />
      ))}
    </div>
  );
}
