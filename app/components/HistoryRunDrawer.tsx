'use client';

import { useEffect, useRef, useState } from 'react';
import type { RunRecord } from '../../lib/shared/workflow';
import RunRecordDetails from './RunRecordDetails';
import RerunWorkflowButton, { RecordedRunInputs } from './RerunWorkflowButton';
import styles from './HistoryRunDrawer.module.css';

interface Props {
  workflowId: string;
  runId: string;
  onClose: () => void;
}

type DetailState = { workflowId: string; runId: string } & (
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; record: RunRecord }
);

export default function HistoryRunDrawer({ workflowId, runId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<DetailState>({ workflowId, runId, status: 'loading' });

  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let current = true;
    const identity = { workflowId, runId };
    setDetail({ ...identity, status: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}`, { signal: abort.signal });
        if (response.status === 404) throw new Error('Run details are not available yet. They may still be saving. Please retry.');
        if (!response.ok) throw new Error(`Could not load run details (${response.status}).`);
        const { run } = await response.json() as { run?: Partial<RunRecord> };
        if (!run || run.workflowId !== workflowId || run.runId !== runId) {
          throw new Error('The returned run does not match the selected job. Please retry.');
        }
        // The endpoint may temporarily return an engine snapshot before the
        // complete record is persisted. It intentionally has no event log.
        if (!Array.isArray(run.events) || !Number.isFinite(run.durationMs) || !run.scope || !Number.isFinite(run.startedAt) || !Number.isFinite(run.finishedAt)) {
          throw new Error('Run details are still being saved. Please retry.');
        }
        if (current) setDetail({ ...identity, status: 'ready', record: run as RunRecord });
      } catch (error) {
        if (current) setDetail({ ...identity, status: 'error', message: error instanceof Error ? error.message : 'Could not load run details.' });
      }
    })();
    return () => { current = false; abort.abort(); };
  }, [workflowId, runId, attempt]);

  // Hide previous content immediately on an identity change, before effects run.
  const selected = detail.workflowId === workflowId && detail.runId === runId ? detail : null;
  const record = selected?.status === 'ready' ? selected.record : null;

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label="Run history detail"
      className={styles.backdrop}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={styles.drawer}>
        <header className={styles.header}>
          <h2>Run history detail</h2>
          <div className={styles.headerActions}>
            {record && <RerunWorkflowButton key={`rerun:${workflowId}/${runId}`} record={record} compact />}
            <button ref={closeRef} type="button" className="btn btn-ghost" aria-label="Close run history" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className={styles.content}>
          <dl className={styles.identity}>
            <div><dt>Flow</dt><dd aria-label="Workflow ID">{workflowId}</dd></div>
            <div><dt>Run</dt><dd aria-label="Run ID">{runId}</dd></div>
          </dl>
          {record && <span className="pill" aria-label="recorded run status" data-status={record.status}><span className="dot" /> {record.status}</span>}
          {(!selected || selected.status === 'loading') && <p role="status">Loading run details…</p>}
          {selected?.status === 'error' && <div role="alert"><p>{selected.message}</p><button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>}
          {record && <RecordedRunInputs scope={record.scope} />}
          {record && <RunRecordDetails key={`${workflowId}/${runId}`} record={record} />}
        </div>
      </div>
    </dialog>
  );
}
