'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunSnapshot, RunSummary, WorkflowEvent } from '../shared/workflow';
import {
  applyHomeJobEvent, homeJobRows, isTerminalStatus, mergeJobHistory, mergeJobSnapshots,
  runFromSnapshot, type HomeJobsState, type HomeQueuedJob, type HomeRun,
} from './home-jobs';

type Resource = 'active' | 'queue' | 'history';
const resources: Resource[] = ['active', 'queue', 'history'];
const paths: Record<Resource, string> = { active: '/api/run', queue: '/api/triggers/queue', history: '/api/runs' };
const labels: Record<Resource, string> = { active: 'running jobs', queue: 'queued jobs', history: 'recent jobs' };
const displayEvents = new Set([
  'run_started', 'run_finished', 'node_started', 'node_finished',
  'node_waiting_for_human', 'node_human_decided', 'node_waiting_for_lock', 'node_lock_acquired',
  'node_waiting_for_slot', 'node_slot_acquired',
]);
interface ActiveRun {
  runId: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt?: number;
  waitingFor?: RunSnapshot['waitingFor'];
  pendingHumanDecisions?: Array<{ nodeId: string }>;
}

function mergeActive(state: HomeJobsState, items: ActiveRun[], snapshot?: RunSnapshot): HomeJobsState {
  const runs: Record<string, HomeRun> = Object.fromEntries(Object.entries(state.runs).filter(([, run]) => run.status !== 'running'));
  for (const item of items) {
    if (!item.runId || !item.workflowId) continue;
    if (runs[item.runId] && (!runs[item.runId].provisional || !isTerminalStatus(item.status))) continue;
    const previous = state.runs[item.runId];
    const detailed = snapshot?.runId === item.runId ? runFromSnapshot(snapshot, previous) : undefined;
    const status = isTerminalStatus(item.status) ? item.status : 'running';
    const stages = { ...(detailed?.stages ?? previous?.stages ?? {}) };
    if (item.waitingFor) {
      const { nodeId, kind } = item.waitingFor;
      stages[nodeId] = { ...stages[nodeId], nodeId, waiting: kind };
    }
    for (const pending of item.pendingHumanDecisions ?? []) {
      stages[pending.nodeId] = { ...stages[pending.nodeId], nodeId: pending.nodeId, waiting: 'human' };
    }
    runs[item.runId] = {
      runId: item.runId, workflowId: item.workflowId,
      workflowName: item.workflowName ?? previous?.workflowName,
      status, startedAt: item.startedAt ?? detailed?.startedAt ?? previous?.startedAt,
      stages: status === 'running' ? stages : {},
      ...(status === 'running' ? {} : { finishedAt: detailed?.finishedAt ?? previous?.finishedAt ?? Date.now(), provisional: true }),
    };
  }
  // The compatibility snapshot may retain the just-finished controller after
  // it has already left the active registry, before history is persisted.
  if (snapshot && isTerminalStatus(snapshot.status) && snapshot.runId && !runs[snapshot.runId]) {
    const completed = runFromSnapshot(snapshot, state.runs[snapshot.runId]);
    if (completed) runs[completed.runId] = completed;
  }
  return { ...state, runs };
}

export function useHomeJobs() {
  const [state, setState] = useState<HomeJobsState>({ runs: {}, queue: {} });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'reconnecting'>('connecting');
  const retryRef = useRef<() => void>(() => {});
  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    let alive = true;
    let current: HomeJobsState = { runs: {}, queue: {} };
    const abort = new AbortController();
    const versions = { active: 0, queue: 0 };
    const inFlight = new Set<Resource>();
    const again = new Set<Resource>();
    const settled = new Set<Resource>();
    const failures = new Map<Resource, string>();
    const timers = new Map<Resource, ReturnType<typeof setTimeout>>();
    let historyAttempts = 0;
    let reconcileReconnect = false;
    const publish = () => {
      if (!alive) return;
      setState(current);
      setLoading(settled.size < resources.length);
      setErrors([...failures.values()]);
    };
    const schedule = (resource: Resource, delay = 100) => {
      if (!alive || timers.has(resource)) return;
      timers.set(resource, setTimeout(() => {
        timers.delete(resource);
        void refresh(resource);
      }, delay));
    };

    async function refresh(resource: Resource): Promise<void> {
      if (!alive) return;
      if (inFlight.has(resource)) { again.add(resource); return; }
      const timer = timers.get(resource);
      if (timer) { clearTimeout(timer); timers.delete(resource); }
      inFlight.add(resource);
      const version = resource === 'history' ? 0 : versions[resource];
      try {
        const response = await fetch(paths[resource], { signal: abort.signal });
        if (!response.ok) throw new Error(`Could not load ${labels[resource]} (${response.status}).`);
        const data = await response.json();
        if (!alive) return;
        if (resource !== 'history' && version !== versions[resource]) {
          again.add(resource);
          return;
        }
        if (resource === 'queue') {
          if (!Array.isArray(data.items)) throw new Error('Could not read queued jobs.');
          const items = data.items as HomeQueuedJob[];
          current = { ...current, queue: Object.fromEntries(items.filter((item) => item.queueId && item.workflowId).map((item) => [item.queueId, {
            queueId: item.queueId, workflowId: item.workflowId, workflowName: item.workflowName,
            receivedAt: item.receivedAt, position: item.position,
          }])) };
        } else if (resource === 'active') {
          if (!Array.isArray(data.runs)) throw new Error('Could not read running jobs.');
          current = mergeActive(current, data.runs, data.state);
          if (Object.values(current.runs).some((run) => run.provisional)) schedule('history');
        } else {
          if (!Array.isArray(data.runs)) throw new Error('Could not read recent jobs.');
          current = mergeJobHistory(current, data.runs as RunSummary[]);
        }
        failures.delete(resource);
      } catch (error) {
        if (!alive) return;
        failures.set(resource, error instanceof Error ? error.message : `Could not load ${labels[resource]}.`);
      } finally {
        inFlight.delete(resource);
        if (alive) {
          // A completion event can be missed while disconnected, and its
          // history write can still be pending when the new snapshot arrives.
          // Reconcile for a bounded window even without a known terminal row.
          if (resource === 'history' && (reconcileReconnect || Object.values(current.runs).some((run) => run.provisional))) {
            if (historyAttempts < 3) schedule('history', [500, 1500, 4000][historyAttempts++]);
            else reconcileReconnect = false;
          }
          settled.add(resource);
          publish();
          if (again.delete(resource)) schedule(resource);
        }
      }
    }

    const refreshAll = () => {
      historyAttempts = 0;
      for (const resource of resources) void refresh(resource);
    };
    retryRef.current = refreshAll;
    refreshAll();
    let stream: EventSource | undefined;
    let hasOpened = false;
    try {
      stream = new EventSource('/api/events');
      stream.onopen = () => {
        if (!alive) return;
        setConnection('open');
        if (hasOpened) {
          reconcileReconnect = true;
          refreshAll();
        }
        hasOpened = true;
      };
      stream.onerror = () => { if (alive) setConnection('reconnecting'); };
      stream.onmessage = (message) => {
        if (!alive || typeof message.data !== 'string') return;
        try {
          const data = JSON.parse(message.data);
          if (!data || typeof data.type !== 'string') return;
          if (data.type === 'state_snapshot') {
            const snapshots = Array.isArray(data.runs) ? data.runs : data.state ? [data.state] : [];
            current = mergeJobSnapshots(current, snapshots);
            versions.active += 1;
            schedule('active');
            if (Object.values(current.runs).some((run) => run.provisional)) schedule('history');
            publish();
            return;
          }
          const isQueue = ['trigger_enqueued', 'trigger_started', 'trigger_removed', 'trigger_dropped'].includes(data.type);
          if (!isQueue && !displayEvents.has(data.type)) return;
          current = applyHomeJobEvent(current, data as WorkflowEvent);
          if (isQueue) {
            versions.queue += 1;
            schedule('queue');
          }
          if (displayEvents.has(data.type) || data.type === 'trigger_started') {
            versions.active += 1;
            if (data.type === 'run_started' || data.type === 'trigger_started' || !current.runs[data.runId]) schedule('active');
          }
          if (data.type === 'run_finished') {
            historyAttempts = 0;
            schedule('history');
          }
          publish();
        } catch {
          // Ignore malformed stream frames; reconnect/retry snapshots reconcile state.
        }
      };
    } catch {
      setConnection('reconnecting');
    }
    return () => {
      alive = false;
      retryRef.current = () => {};
      abort.abort();
      stream?.close();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  return { jobs: homeJobRows(state), loading, errors, connection, retry };
}
