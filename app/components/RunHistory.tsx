'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunRecord, RunSummary } from '../../lib/shared/workflow';
import { useWorkflowStore } from '../../lib/client/workflow-store-client';
import { eventNodeId } from '../../lib/client/group-events';
import RunRecordDetails from './RunRecordDetails';

interface Props {
  workflowId: string | undefined;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

export default function RunHistory({ workflowId }: Props) {
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const selectNode = useWorkflowStore((s) => s.selectNode);
  const requestPanToNode = useWorkflowStore((s) => s.requestPanToNode);
  const setInspectedRunEvents = useWorkflowStore((s) => s.setInspectedRunEvents);

  // A history record is a canvas overlay, not a replacement for the live run
  // state. Clear it as soon as History closes or this component unmounts.
  useEffect(() => () => setInspectedRunEvents(null), [setInspectedRunEvents]);

  // Filter is only active if a node is selected AND that node has events in
  // the currently-loaded run record. A selection from an earlier/later run
  // shouldn't blank out an unrelated run's log.
  const nodeHasEventsInRun = useMemo(() => {
    if (!record || !selectedNodeId) return false;
    return record.events.some((ev) => eventNodeId(ev) === selectedNodeId);
  }, [record, selectedNodeId]);
  const filterActive = !!selectedNodeId && nodeHasEventsInRun;

  // Track which workflow the most recent in-flight list fetch was for, so a
  // stale response (older workflow's data arriving after the user switched)
  // can't overwrite a fresher list.
  const listForRef = useRef<string | undefined>(undefined);

  const refreshList = useCallback(async () => {
    if (!workflowId) {
      setSummaries([]);
      return;
    }
    listForRef.current = workflowId;
    const requestedFor = workflowId;
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch(
        `/api/runs?workflowId=${encodeURIComponent(workflowId)}`,
      );
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const data = (await res.json()) as { runs: RunSummary[] };
      if (listForRef.current !== requestedFor) return;
      setSummaries(data.runs ?? []);
    } catch (err) {
      if (listForRef.current !== requestedFor) return;
      setListError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      if (listForRef.current === requestedFor) setListLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Switching workflows clears any in-progress detail view.
  useEffect(() => {
    setSelectedRunId(null);
    setRecord(null);
    setRecordError(null);
    setInspectedRunEvents(null);
  }, [workflowId, setInspectedRunEvents]);

  useEffect(() => {
    if (!selectedRunId || !workflowId) {
      setRecord(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setRecordLoading(true);
      setRecordError(null);
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(selectedRunId)}`,
        );
        if (!res.ok) throw new Error(`load failed: ${res.status}`);
        const data = (await res.json()) as { run: RunRecord };
        if (!cancelled) {
          setRecord(data.run);
          setInspectedRunEvents(data.run.events);
        }
      } catch (err) {
        if (!cancelled) {
          setRecordError(err instanceof Error ? err.message : 'failed to load');
        }
      } finally {
        if (!cancelled) setRecordLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, workflowId, setInspectedRunEvents]);

  if (selectedRunId) {
    return (
      <aside aria-label="run history detail" className="run-view">
        <header className="run-view-head">
          <button
            type="button"
            className="wf-menu-action"
            aria-label="back to history list"
            onClick={() => {
              setSelectedRunId(null);
              setInspectedRunEvents(null);
            }}
          >
            ← back
          </button>
          {record ? (
            <span
              className="pill"
              aria-label="recorded run status"
              data-status={record.status}
            >
              <span className="dot" /> {record.status}
            </span>
          ) : null}
          {filterActive ? (
            <span className="run-history-filter-chip" role="status">
              <span aria-label={`filtered to node ${selectedNodeId}`}>
                filtered: {selectedNodeId}
              </span>
              <button
                type="button"
                className="run-history-filter-clear"
                aria-label="clear node filter"
                onClick={() => selectNode(null)}
              >
                ×
              </button>
            </span>
          ) : null}
        </header>

        {recordLoading && (
          <div className="wf-menu-empty serif-italic">loading…</div>
        )}
        {recordError && !recordLoading && (
          <div
            className="wf-menu-empty wf-menu-error serif-italic"
            aria-label="run history error"
          >
            {recordError}
          </div>
        )}

        {record && !recordLoading && (
          <RunRecordDetails
            record={record}
            filterNodeId={filterActive ? selectedNodeId ?? undefined : undefined}
            onCardActivate={(nodeId) => {
              selectNode(nodeId);
              requestPanToNode(nodeId);
            }}
          />
        )}
      </aside>
    );
  }

  return (
    <aside aria-label="run history" className="run-view">
      <header className="run-view-head">
        <span className="run-view-ws">history</span>
      </header>

      {listLoading && (
        <div className="wf-menu-empty serif-italic">loading…</div>
      )}
      {listError && !listLoading && (
        <div
          className="wf-menu-empty wf-menu-error serif-italic"
          aria-label="run history error"
        >
          {listError}
        </div>
      )}
      {!listLoading && !listError && summaries.length === 0 && (
        <div className="run-history-empty" role="status">
          <p className="run-history-empty-title">
            {workflowId ? 'no recorded runs yet' : 'load a workflow first'}
          </p>
          <p className="run-history-empty-hint">
            {workflowId
              ? 'Click Run to execute the current workflow; completed runs will appear here.'
              : 'Select a workflow from the menu to view its recorded runs.'}
          </p>
        </div>
      )}

      <div className="run-view-log" aria-label="run history list">
        {summaries.map((s) => (
          <button
            key={s.runId}
            type="button"
            aria-label={`run ${s.runId}`}
            className="run-history-row"
            data-status={s.status}
            onClick={() => setSelectedRunId(s.runId)}
          >
            <span className="run-history-row-status">{s.status}</span>
            <span className="run-history-row-meta">
              {fmtTime(s.startedAt)} · {fmtDuration(s.durationMs)} ·{' '}
              {s.eventCount} ev
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
