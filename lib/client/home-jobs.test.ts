import { expect, it } from 'bun:test';
import type { RunSnapshot, RunSummary, WorkflowEvent } from '../shared/workflow';
import { applyHomeJobEvent, formatJobDuration, homeJobRows, mergeJobHistory, mergeJobSnapshots, runFromSnapshot, type HomeJobsState } from './home-jobs';

const empty = (): HomeJobsState => ({ runs: {}, queue: {} });
const event = (value: object) => value as WorkflowEvent;
const summary = (id: string, finishedAt: number): RunSummary => ({ runId: id, workflowId: 'flow', workflowName: 'Flow', status: 'succeeded', startedAt: 1, finishedAt, durationMs: finishedAt - 1 } as RunSummary);

it('keeps one completion through delayed persistence and reconciles its real timestamps', () => {
  let state = applyHomeJobEvent(empty(), event({ type: 'run_started', runId: 'run', workflowId: 'flow', workflowName: 'Flow' }));
  state = applyHomeJobEvent(state, event({ type: 'run_finished', runId: 'run', status: 'succeeded', scope: { secret: 'excluded' } }), 100);
  state = mergeJobHistory(state, []);
  expect(homeJobRows(state)).toHaveLength(1);
  expect(state.runs.run.provisional).toBe(true);
  expect(JSON.stringify(state)).not.toContain('secret');
  state = mergeJobHistory(state, [summary('run', 90)]);
  expect(homeJobRows(state)).toHaveLength(1);
  expect(state.runs.run.finishedAt).toBe(90);
  expect(state.runs.run.provisional).toBeUndefined();
  expect(applyHomeJobEvent(state, event({ type: 'run_started', runId: 'run', workflowId: 'flow' }))).toBe(state);
});

it('orders running, FIFO queue, and only the latest twenty completions by finish time', () => {
  let state = mergeJobHistory(empty(), Array.from({ length: 25 }, (_, i) => summary(`past-${i}`, i + 1)));
  state = applyHomeJobEvent(state, event({ type: 'run_started', runId: 'active', workflowId: 'flow' }));
  state.queue = {
    second: { queueId: 'second', workflowId: 'flow', position: 2, receivedAt: 20 },
    first: { queueId: 'first', workflowId: 'flow', position: 1, receivedAt: 10 },
  };
  const rows = homeJobRows(state);
  expect(rows.map((row) => row.kind === 'run' ? row.runId : row.queueId)).toEqual(['active', 'first', 'second', ...Array.from({ length: 20 }, (_, i) => `past-${24 - i}`)]);
});

it('tracks concurrent stages and waiting state without retaining event payloads', () => {
  let state = applyHomeJobEvent(empty(), event({ type: 'run_started', runId: 'run', workflowId: 'flow' }));
  state = applyHomeJobEvent(state, event({ type: 'node_started', runId: 'run', nodeId: 'a', nodeType: 'agent', resolvedConfig: { secret: 'excluded' } }));
  state = applyHomeJobEvent(state, event({ type: 'node_started', runId: 'run', nodeId: 'b', nodeType: 'script' }));
  state = applyHomeJobEvent(state, event({ type: 'node_waiting_for_slot', runId: 'run', nodeId: 'b' }));
  expect(Object.keys(state.runs.run.stages)).toEqual(['a', 'b']);
  expect(state.runs.run.stages.b.waiting).toBe('slot');
  state = applyHomeJobEvent(state, event({ type: 'node_slot_acquired', runId: 'run', nodeId: 'b' }));
  state = applyHomeJobEvent(state, event({ type: 'node_finished', runId: 'run', nodeId: 'a', nodeType: 'agent' }));
  expect(Object.keys(state.runs.run.stages)).toEqual(['b']);
  expect(state.runs.run.stages.b.waiting).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain('secret');
});

it('rebuilds reconnect stages from snapshots and retains terminal jobs without resurrecting them', () => {
  const snapshot = { runId: 'active', workflowId: 'flow', status: 'running', startedAt: 5, events: [
    event({ type: 'node_started', nodeId: 'a', nodeType: 'script' }),
    event({ type: 'node_started', nodeId: 'b', nodeType: 'agent' }),
    event({ type: 'node_finished', nodeId: 'a' }),
  ], waitingFor: { kind: 'human', nodeId: 'b' } } as RunSnapshot;
  expect(runFromSnapshot(snapshot)?.stages).toEqual({ b: { nodeId: 'b', nodeType: 'agent', waiting: 'human' } });
  let state = mergeJobHistory(empty(), [summary('done', 10)]);
  state = applyHomeJobEvent(state, event({ type: 'run_started', runId: 'stale', workflowId: 'flow' }));
  state = mergeJobSnapshots(state, [snapshot, { ...snapshot, runId: 'done' }]);
  expect(Object.keys(state.runs).sort()).toEqual(['active', 'done']);
  expect(state.runs.done.status).toBe('succeeded');
  state = mergeJobSnapshots(state, [{ ...snapshot, runId: 'done', status: 'succeeded', finishedAt: 11 }]);
  expect(state.runs.done.finishedAt).toBe(10);
  expect(state.runs.done.durationMs).toBe(9);
  expect(state.runs.done.provisional).toBeUndefined();
});

it('moves queued jobs into a single running row and formats elapsed time', () => {
  let state = applyHomeJobEvent(empty(), event({ type: 'trigger_enqueued', queueId: 'q', workflowId: 'flow', position: 1, receivedAt: 1 }));
  state = applyHomeJobEvent(state, event({ type: 'trigger_started', queueId: 'q', workflowId: 'flow', runId: 'run' }));
  state = applyHomeJobEvent(state, event({ type: 'run_started', workflowId: 'flow', runId: 'run', workflowName: 'Flow' }));
  expect(homeJobRows(state)).toHaveLength(1);
  expect(state.runs.run.startedAt).toBeUndefined();
  expect(formatJobDuration(3_661_999)).toBe('1:01:01');
  expect(formatJobDuration(-1)).toBe('00:00');
});
