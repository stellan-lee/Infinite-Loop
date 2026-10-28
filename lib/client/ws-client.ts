'use client';

import { useEffect, useState } from 'react';
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
  'node_waiting_for_lock',
  'node_lock_acquired',
  'node_waiting_for_slot',
  'node_slot_acquired',
  'node_waiting_for_human',
  'node_human_decided',
  'github_ci_updated',
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
): v is { type: 'state_snapshot'; state: RunSnapshot; runs?: RunSnapshot[]; runId?: string } {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'state_snapshot';
}

/**
 * Subscribe to the engine's Server-Sent Events stream and dispatch parsed
 * `WorkflowEvent`s into the Zustand store. Reconnects automatically on drop
 * (the browser's EventSource handles backoff itself; we surface the status).
 */
export function useEngineWebSocket(workflowId?: string | null): string | undefined {
  const [runId, setRunId] = useState<string>();
  const setConnectionStatus = useWorkflowStore((s) => s.setConnectionStatus);
  const appendRunEvent = useWorkflowStore((s) => s.appendRunEvent);
  const hydrateRun = useWorkflowStore((s) => s.hydrateRun);

  useEffect(() => {
    setRunId(undefined);
    if (typeof window === 'undefined' || workflowId === null) return;

    const es = new EventSource('/api/events');
    let active = true;
    let selectedRunId: string | undefined;
    setConnectionStatus('connecting');

    es.onopen = () => setConnectionStatus('open');

    es.onmessage = (e) => {
      if (!active) return;
      if (typeof e.data !== 'string' || e.data.length === 0) return;
      try {
        const data = JSON.parse(e.data);
        if (isWorkflowEvent(data)) {
          if (workflowId) {
            if (data.type === 'run_started') {
              if (data.workflowId !== workflowId) return;
              selectedRunId = data.runId;
              setRunId(selectedRunId);
            } else if (data.type === 'trigger_started') {
              if (data.workflowId !== workflowId) return;
            } else if (!selectedRunId || !('runId' in data) || data.runId !== selectedRunId) {
              return;
            }
          }
          appendRunEvent(data);
        } else if (isStateSnapshot(data)) {
          // Initial frame on connect: hydrate run status AND the recent event
          // log so a page refresh mid-run brings back the live-node highlight
          // on the canvas plus the streaming-stdout history in the right
          // panel. Live events from this point onward append normally.
          const state = workflowId
            ? [...(data.runs ?? []), ...(data.state ? [data.state] : [])]
              .filter((run) => run.workflowId === workflowId)
              .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
            : data.state;
          selectedRunId = state?.runId;
          setRunId(selectedRunId);
          const status = state?.status ?? 'idle';
          const events = Array.isArray(state?.events)
            ? state.events
            : [];
          hydrateRun({ status, events, githubCI: state?.githubCI });
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
      active = false;
      es.close();
    };
  }, [workflowId, setConnectionStatus, appendRunEvent, hydrateRun]);
  return runId;
}
