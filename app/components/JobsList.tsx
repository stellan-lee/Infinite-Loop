'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Workflow, WorkflowSummary } from '../../lib/shared/workflow';
import { walkWorkflowNodes } from '../../lib/shared/workflow-graph';
import { formatJobDuration, type HomeRun, type JobStage } from '../../lib/client/home-jobs';
import { useHomeJobs } from '../../lib/client/home-jobs-client';
import HistoryRunDrawer from './HistoryRunDrawer';
import styles from './JobsList.module.css';

const statusLabels = {
  queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed',
  exhausted: 'Exhausted', cancelled: 'Cancelled',
};
type NodeLabels = Record<string, string>;

function stageLabel(stage: JobStage, labels?: NodeLabels): string {
  const name = labels?.[stage.nodeId] ?? stage.nodeType?.replaceAll('-', ' ') ?? stage.nodeId;
  const waiting = stage.waiting === 'human' ? 'Waiting for review'
    : stage.waiting === 'lock' ? 'Waiting for folder access'
      : stage.waiting === 'slot' ? 'Waiting for capacity' : undefined;
  return waiting ? `${waiting} · ${name}` : name;
}

export default function JobsList({ flows, active = true }: { flows: WorkflowSummary[]; active?: boolean }) {
  const { jobs, loading, errors, connection, retry } = useHomeJobs();
  const [now, setNow] = useState(() => Date.now());
  const [nodeLabels, setNodeLabels] = useState<Record<string, NodeLabels>>({});
  const [selectedRun, setSelectedRun] = useState<{ workflowId: string; runId: string } | null>(null);
  const closeHistory = useCallback(() => setSelectedRun(null), []);
  useEffect(() => {
    // The shared console keeps Jobs mounted while its pane closes. A native
    // modal must leave the top layer when this view becomes inactive.
    if (!active) setSelectedRun(null);
  }, [active]);
  const running = jobs.filter((job): job is HomeRun & { kind: 'run' } => job.kind === 'run' && job.status === 'running');
  const activeFlowIds = [...new Set(running.map((job) => job.workflowId))].sort().join('\n');

  useEffect(() => {
    if (!running.length) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length > 0]);

  useEffect(() => {
    if (!activeFlowIds) return;
    const abort = new AbortController();
    let alive = true;
    for (const id of activeFlowIds.split('\n')) {
      void (async () => {
        try {
          const response = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { signal: abort.signal });
          if (!response.ok) return;
          const data = await response.json() as { workflow?: Workflow };
          if (!alive || !Array.isArray(data.workflow?.nodes)) return;
          const labels: NodeLabels = {};
          walkWorkflowNodes(data.workflow.nodes, (node) => { labels[node.id] = node.label?.trim() || node.type.replaceAll('-', ' '); });
          setNodeLabels((previous) => ({ ...previous, [id]: labels }));
        } catch { /* A stage can still use its type or ID when metadata is unavailable. */ }
      })();
    }
    return () => { alive = false; abort.abort(); };
  }, [activeFlowIds]);

  const names = new Map(flows.map((flow) => [flow.id, flow.name]));
  return (
    <section className={styles.panel} aria-labelledby="home-jobs-heading">
      <div className={styles.heading}>
        <h2 id="home-jobs-heading">Jobs</h2>
        <span className={styles.connection} role="status">
          {connection === 'open' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </span>
      </div>
      {errors.length > 0 && (
        <div className={styles.error} role="alert">
          <p>{errors.join(' ')}</p>
          <button type="button" className="btn" onClick={retry}>Retry</button>
        </div>
      )}
      {loading && <p className={styles.notice} role="status">Loading jobs…</p>}
      {!loading && !errors.length && !jobs.length && <p className={styles.notice}>No jobs yet. Run a flow to see its progress here.</p>}
      <ul className={styles.list} data-testid="jobs-list" aria-label="Jobs">
        {jobs.map((job) => {
          const id = job.kind === 'queue' ? job.queueId : job.runId;
          const stages = job.kind === 'run' ? Object.values(job.stages) : [];
          const elapsed = job.kind === 'run' && job.startedAt !== undefined ? formatJobDuration(now - job.startedAt) : '—';
          const finished = job.kind === 'run' && job.status !== 'running';
          const content = <>
            <span className={styles.rowTop}>
              <span className={styles.name}>{names.get(job.workflowId) ?? job.workflowName ?? job.workflowId}</span>
              <span className={styles.status}>{statusLabels[job.status]}</span>
            </span>
            {job.kind === 'queue' ? (
              <span className={styles.detail}>Position {job.position}</span>
            ) : job.status === 'running' ? (
              <span className={styles.liveDetail}>
                <span className={styles.detail}>Stage: {stages.length ? stages.map((stage) => stageLabel(stage, nodeLabels[job.workflowId])).join(' · ') : 'Starting'}</span>
                <span className={styles.elapsed} aria-label="Elapsed time">{elapsed}</span>
              </span>
            ) : (
              <span className={styles.detail}>
                {job.provisional ? 'Final details pending' : <>
                  {job.finishedAt !== undefined && <time dateTime={new Date(job.finishedAt).toISOString()}>{new Date(job.finishedAt).toLocaleString()}</time>}
                  {job.durationMs !== undefined && <> · {formatJobDuration(job.durationMs)}</>}
                </>}
              </span>
            )}
          </>;
          return (
            <li key={`${job.kind}-${id}`} className={`${styles.row} ${finished ? styles.finished : ''}`} data-testid={`job-row-${id}`} data-status={job.status}>
              {finished ? <button type="button" className={styles.openRun} aria-label={`View run ${job.runId}`} onClick={() => setSelectedRun({ workflowId: job.workflowId, runId: job.runId })}>{content}</button> : content}
            </li>
          );
        })}
      </ul>
      {active && selectedRun && <HistoryRunDrawer workflowId={selectedRun.workflowId} runId={selectedRun.runId} onClose={closeHistory} />}
    </section>
  );
}
