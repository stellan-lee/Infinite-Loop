import type { NodeType, RunSnapshot, RunSummary, TerminalRunStatus, WorkflowEvent } from '../shared/workflow';

export const RECENT_JOB_LIMIT = 20;
export type JobStage = { nodeId: string; nodeType?: NodeType; waiting?: 'human' | 'lock' | 'slot' };
export interface HomeRun {
  runId: string;
  workflowId: string;
  workflowName?: string;
  status: 'running' | TerminalRunStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  stages: Record<string, JobStage>;
  /** An observed completion stays visible until the asynchronous history write arrives. */
  provisional?: boolean;
}
export interface HomeQueuedJob {
  queueId: string;
  workflowId: string;
  workflowName?: string;
  receivedAt: number;
  position: number;
}
export interface HomeJobsState {
  runs: Record<string, HomeRun>;
  queue: Record<string, HomeQueuedJob>;
}
export type HomeJob = ({ kind: 'run' } & HomeRun) | ({ kind: 'queue'; status: 'queued' } & HomeQueuedJob);

export function isTerminalStatus(status: unknown): status is TerminalRunStatus {
  return status === 'succeeded' || status === 'failed' || status === 'exhausted' || status === 'cancelled';
}

function boundedRuns(runs: Record<string, HomeRun>): Record<string, HomeRun> {
  const values = Object.values(runs);
  const finished = values.filter((run) => run.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, RECENT_JOB_LIMIT);
  return Object.fromEntries([...values.filter((run) => run.status === 'running'), ...finished].map((run) => [run.runId, run]));
}

function updateStage(stages: Record<string, JobStage>, event: WorkflowEvent): Record<string, JobStage> {
  if (!('nodeId' in event) || !event.nodeId) return stages;
  const nodeId = event.nodeId;
  if (event.type === 'node_started') return { ...stages, [nodeId]: { nodeId, nodeType: event.nodeType } };
  if (event.type === 'node_finished') {
    const next = { ...stages };
    delete next[nodeId];
    return next;
  }
  const waiting = event.type === 'node_waiting_for_human' ? 'human'
    : event.type === 'node_waiting_for_lock' ? 'lock'
      : event.type === 'node_waiting_for_slot' ? 'slot' : undefined;
  if (waiting) return { ...stages, [nodeId]: { ...stages[nodeId], nodeId, waiting } };
  if (event.type === 'node_human_decided' || event.type === 'node_lock_acquired' || event.type === 'node_slot_acquired') {
    return { ...stages, [nodeId]: { ...stages[nodeId], nodeId, waiting: undefined } };
  }
  return stages;
}

export function runFromSnapshot(snapshot: RunSnapshot, previous?: HomeRun): HomeRun | undefined {
  if (!snapshot.runId || !snapshot.workflowId || (snapshot.status !== 'running' && !isTerminalStatus(snapshot.status))) return;
  let stages: Record<string, JobStage> = {};
  for (const event of snapshot.events ?? []) stages = updateStage(stages, event);
  if (snapshot.status === 'running') {
    if (snapshot.currentNodeId && !Object.keys(stages).length) stages[snapshot.currentNodeId] = { nodeId: snapshot.currentNodeId };
    if (snapshot.waitingFor) {
      const { nodeId, kind } = snapshot.waitingFor;
      stages[nodeId] = { ...stages[nodeId], nodeId, waiting: kind };
    }
  } else stages = {};
  return {
    runId: snapshot.runId, workflowId: snapshot.workflowId,
    workflowName: previous?.workflowName, status: snapshot.status,
    startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt, stages,
    provisional: snapshot.status !== 'running',
  };
}

/** A reconnect snapshot is authoritative for active jobs; retained completions are separate. */
export function mergeJobSnapshots(state: HomeJobsState, snapshots: RunSnapshot[]): HomeJobsState {
  const runs = Object.fromEntries(Object.entries(state.runs).filter(([, run]) => run.status !== 'running'));
  for (const snapshot of snapshots) {
    const run = runFromSnapshot(snapshot, state.runs[snapshot.runId ?? '']);
    if (!run) continue;
    const completed = runs[run.runId];
    // Persisted metadata is more complete than the transient engine snapshot.
    if (completed && (!completed.provisional || run.status === 'running')) continue;
    runs[run.runId] = run;
  }
  return { ...state, runs: boundedRuns(runs) };
}

export function mergeJobHistory(state: HomeJobsState, history: RunSummary[]): HomeJobsState {
  const runs = Object.fromEntries(Object.entries(state.runs).filter(([, run]) => run.status === 'running' || run.provisional));
  const recent = history.filter((run) => isTerminalStatus(run.status))
    .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, RECENT_JOB_LIMIT);
  for (const item of recent) {
    runs[item.runId] = {
      runId: item.runId, workflowId: item.workflowId, workflowName: item.workflowName,
      status: item.status, startedAt: item.startedAt, finishedAt: item.finishedAt,
      durationMs: item.durationMs, stages: {},
    };
  }
  return { ...state, runs: boundedRuns(runs) };
}

/** Keep display metadata only; never retain stdout, inputs, resolved configs, or scope. */
export function applyHomeJobEvent(state: HomeJobsState, event: WorkflowEvent, now = Date.now()): HomeJobsState {
  if (event.type === 'trigger_enqueued') {
    const item = { queueId: event.queueId, workflowId: event.workflowId, receivedAt: event.receivedAt, position: event.position };
    return { ...state, queue: { ...state.queue, [item.queueId]: item } };
  }
  if (event.type === 'trigger_started' || event.type === 'trigger_removed' || event.type === 'trigger_dropped') {
    const queue = { ...state.queue };
    const queued = queue[event.queueId];
    delete queue[event.queueId];
    if (event.type !== 'trigger_started') return { ...state, queue };
    const existing = state.runs[event.runId];
    return { queue, runs: { ...state.runs, [event.runId]: existing ?? {
      runId: event.runId, workflowId: event.workflowId, workflowName: queued?.workflowName,
      status: 'running', stages: {},
    } } };
  }
  if (!('runId' in event) || !event.runId) return state;
  const runId = event.runId;
  const previous = state.runs[runId];
  if (event.type === 'run_started') {
    if (previous && previous.status !== 'running') return state;
    return { ...state, runs: { ...state.runs, [runId]: {
      ...previous, runId, workflowId: event.workflowId, workflowName: event.workflowName,
      status: 'running', stages: previous?.stages ?? {},
    } } };
  }
  if (!previous || previous.status !== 'running') return state;
  if (event.type === 'run_finished') {
    return { ...state, runs: boundedRuns({ ...state.runs, [runId]: {
      ...previous, status: event.status, finishedAt: now, stages: {}, provisional: true,
    } }) };
  }
  const stages = updateStage(previous.stages, event);
  if (stages === previous.stages) return state;
  return { ...state, runs: { ...state.runs, [runId]: { ...previous, stages } } };
}

export function homeJobRows(state: HomeJobsState): HomeJob[] {
  const runs = Object.values(state.runs).filter((run) => run.workflowId);
  return [
    ...runs.filter((run) => run.status === 'running').sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .map((run) => ({ ...run, kind: 'run' as const })),
    ...Object.values(state.queue).sort((a, b) => a.position - b.position || a.receivedAt - b.receivedAt)
      .map((item) => ({ ...item, kind: 'queue' as const, status: 'queued' as const })),
    ...runs.filter((run) => run.status !== 'running').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, RECENT_JOB_LIMIT).map((run) => ({ ...run, kind: 'run' as const })),
  ];
}

export function formatJobDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
