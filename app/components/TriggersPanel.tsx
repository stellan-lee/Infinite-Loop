'use client';

import type { Workflow } from '@/lib/shared/workflow';
import { useEffect, useState } from 'react';
import type { WebhookTrigger } from '@/lib/shared/trigger';

export interface TriggersPanelProps {
  workflow: Workflow;
  origin: string;
}

export function TriggersPanel({ workflow }: TriggersPanelProps) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/triggers?workflowId=${encodeURIComponent(workflow.id)}`);
        if (!r.ok) return;
        const json = (await r.json()) as { triggers: WebhookTrigger[] };
        if (alive) setCount(json.triggers.length);
      } catch {
        /* ignore */
      }
    })();
    return () => { alive = false; };
  }, [workflow.id]);

  return (
    <div className="trg-summary">
      <span className="trg-summary-count">
        {count === null ? '…' : count} trigger{count === 1 ? '' : 's'} route{count === 1 ? 's' : ''} here.
      </span>
      <a
        href={`/#dispatch?workflow=${encodeURIComponent(workflow.id)}`}
        className="trg-summary-link"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          window.location.hash = `#dispatch?workflow=${encodeURIComponent(workflow.id)}`;
        }}
      >
        Manage in Dispatch →
      </a>
    </div>
  );
}
