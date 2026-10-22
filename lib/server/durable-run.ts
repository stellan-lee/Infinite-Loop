import type { EdgeHandle, RunSnapshot, Scope, TerminalRunStatus, Workflow, WorkflowNode, WorkflowEvent } from '../shared/workflow';
import type { GitHubCIWait } from './github-ci-service';
import type { RunBudget } from './run-controller';
import { readDurableJSON, removeDurableJSON, writeDurableJSON } from './durable-json';

export interface WalkFrame {
  id: string;
  scopeId: string;
  workflow: Workflow;
  exec: { parentNode?: WorkflowNode; loopIteration?: number; subworkflowStack?: string[] };
  currentNodeId?: string;
  phase: 'ready' | 'executing' | 'ci-wait' | 'child' | 'result' | 'done';
  branch?: EdgeHandle;
  status?: TerminalRunStatus;
  loopSignal?: 'break' | 'continue';
  ci?: GitHubCIWait;
  loop?: { iteration: number; body?: WalkFrame };
  parallel?: {
    parentSnapshot: Scope;
    branches: Record<string, WalkFrame>;
    results: Record<string, BranchResult>;
    /** Keys still sharing their inherited value; restores identity-based output deltas after JSON. */
    inheritedKeys: Record<string, string[]>;
    winners: string[];
    failures: string[];
    outcome?: 'success' | 'error' | 'cancelled';
    cancelled: boolean;
  };
  subworkflow?: { workflow: Workflow; child: WalkFrame; startedAt: number };
}
export interface BranchResult {
  branchId: string;
  status: TerminalRunStatus;
  outputs: Record<string, unknown>;
  error?: string;
}
export interface DurableRun {
  version: 1;
  serverPid: number;
  runId: string;
  correlationId: string;
  workflow: Workflow;
  root: WalkFrame;
  scopes: Record<string, Scope>;
  snapshot: RunSnapshot;
  budget: RunBudget;
  nodeCount: number;
  costUsd: number;
  events: WorkflowEvent[];
  truncated: boolean;
  worktrees: Array<[string, { path: string; repoRoot: string; ref: string }]>;
  terminal?: { status: TerminalRunStatus; errorMessage?: string };
  /** Run-level intent is separate from a cancelled GitHub check conclusion. */
  cancellation?: { reason: 'user' | 'budget'; message: string };
}
export class CheckpointError extends Error {}
export const saveDurableRun = (run: DurableRun) => writeDurableJSON('durable-runs', run.runId, run);
export const removeDurableRun = (runId: string) => removeDurableJSON('durable-runs', runId);
export const listDurableRuns = () => readDurableJSON<DurableRun>('durable-runs');
export function childrenOf(frame: WalkFrame): WalkFrame[] {
  return [
    ...(frame.loop?.body ? [frame.loop.body] : []),
    ...Object.values(frame.parallel?.branches ?? {}),
    ...(frame.subworkflow ? [frame.subworkflow.child] : []),
  ];
}
