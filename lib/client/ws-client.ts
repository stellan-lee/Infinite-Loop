'use client';

import { useEffect } from 'react';
import type { RunSnapshot, WorkflowEvent } from '../shared/workflow';
import { useWorkflowStore } from './workflow-store-client';

const VALID_EVENT_TYPES = new Set<WorkflowEvent['type']>([
  'run_started',
  'node_started',
  'node_finished',
  'stdout_chunk',
  'condition_checked',
  'template_warning',
  'error',
  'run_finished',
  'trigger_enqueued',
  'trigger_started',
  'trigger_dropped',
  'trigger_removed',
]);

function isWorkflowEvent(v: unknown): v is WorkflowEvent {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && VALID_EVENT_TYPES.has(t as WorkflowEvent['type']);
}

function isStateSnapshot(
  v: unknown,
): v is { type: 'state_snapshot'; state: RunSnapshot } {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'state_snapshot';
}

/**
 * Subscribe to the engine's Server-Sent Events stream and dispatch parsed
 * `WorkflowEvent`s into the Zustand store. Reconnects automatically on drop
 * (the browser's EventSource handles backoff itself; we surface the status).
 */
export function useEngineWebSocket(): void {
  const setConnectionStatus = useWorkflowStore((s) => s.setConnectionStatus);
  const appendRunEvent = useWorkflowStore((s) => s.appendRunEvent);
  const hydrateRun = useWorkflowStore((s) => s.hydrateRun);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const es = new EventSource('/api/events');
    setConnectionStatus('connecting');

    es.onopen = () => setConnectionStatus('open');

    es.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length === 0) return;
      try {
        const data = JSON.parse(e.data);
        if (isWorkflowEvent(data)) {
          appendRunEvent(data);
        } else if (isStateSnapshot(data)) {
          // Initial frame on connect: hydrate run status AND the recent event
          // log so a page refresh mid-run brings back the live-node highlight
          // on the canvas plus the streaming-stdout history in the right
          // panel. Live events from this point onward append normally.
          const status = data.state?.status ?? 'idle';
          const events = Array.isArray(data.state?.events)
            ? data.state.events
            : [];
          hydrateRun({ status, events });
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; just reflect the transient state.
      setConnectionStatus('closed');
    };

    return () => {
      es.close();
    };
  }, [setConnectionStatus, appendRunEvent, hydrateRun]);
}
