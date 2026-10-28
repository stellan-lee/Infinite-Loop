import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths';
import { isCorrelationId } from './correlation';
import { eventBus, type EventBus } from './event-bus';
import { createLogger } from './logger';
import { getRun, listRuns } from './run-store';
import { listRunMarkers } from './run-store';
import { listPersistedQueuedRuns } from './queue-store';
import { listDurableRuns } from './durable-run';
import type { RunSummary } from '../shared/workflow';
import type { WebhookReceipt, WebhookReceiptState, WebhookReceiptSummary } from '../shared/webhook-receipt';

const log = createLogger('webhook-receipts');
const terminal = new Set<WebhookReceiptState>([
  'succeeded', 'failed', 'cancelled', 'ignored', 'rejected', 'dropped', 'removed',
]);

function root(): string { return path.join(dataDir(), 'webhook-receipts'); }
function detailPath(id: string): string { return path.join(root(), `${id}.json`); }
function summaryPath(id: string): string { return path.join(root(), 'summaries', `${id}.json`); }

function writeAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function summary(receipt: WebhookReceipt): WebhookReceiptSummary {
  const {
    body: _body, result: _result, serverPid: _serverPid,
    supersededRunIds: _supersededRunIds, ...rest
  } = receipt;
  return rest;
}

function persist(receipt: WebhookReceipt): void {
  writeAtomic(detailPath(receipt.id), receipt);
  writeAtomic(summaryPath(receipt.id), summary(receipt));
}

export function createWebhookReceipt(receipt: WebhookReceipt): void {
  if (!isCorrelationId(receipt.id)) throw new Error('invalid receipt ID');
  if (getWebhookReceipt(receipt.id)) throw new Error('receipt ID already exists');
  try {
    persist(receipt);
  } catch (err) {
    // If the summary failed, do not leave a partial create that a retry cannot
    // resolve or that the list cannot show.
    rmSync(detailPath(receipt.id), { force: true });
    throw err;
  }
}

export function getWebhookReceipt(id: string): WebhookReceipt | undefined {
  if (!isCorrelationId(id)) return undefined;
  try { return JSON.parse(readFileSync(detailPath(id), 'utf8')) as WebhookReceipt; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Atomic update. State only advances, while IDs and HTTP metadata may arrive late. */
export function updateWebhookReceipt(
  id: string,
  patch: Partial<Omit<WebhookReceipt, 'id' | 'receivedAt'>>,
): WebhookReceipt | undefined {
  const prev = getWebhookReceipt(id);
  if (!prev) return undefined;
  const next: WebhookReceipt = {
    ...prev, ...patch, updatedAt: Math.max(Date.now(), prev.updatedAt + 1),
  };
  if (terminal.has(prev.state)) {
    next.state = prev.state;
    next.result = prev.result;
    next.errorMessage = prev.errorMessage;
    next.reason = prev.reason;
  } else if (prev.state === 'running' && (patch.state === 'queued' || patch.state === 'received')) {
    next.state = 'running';
  } else if (prev.state === 'queued' && patch.state === 'received') {
    next.state = 'queued';
  }
  persist(next);
  return next;
}

/** A disk queue survivor is a retry of this delivery, even if a prior run settled. */
function prepareQueuedReplay(receipt: WebhookReceipt, queueId: string, workflowId: string): void {
  const supersededRunIds = receipt.runId
    ? [...(receipt.supersededRunIds ?? []), receipt.runId]
    : receipt.supersededRunIds;
  persist({
    ...receipt,
    state: 'queued', queueId, workflowId, serverPid: process.pid,
    runId: undefined, result: undefined, errorMessage: undefined, reason: undefined,
    supersededRunIds,
    updatedAt: Math.max(Date.now(), receipt.updatedAt + 1),
  });
}

export function listWebhookReceipts(args: {
  workflowId?: string;
  triggerId?: string;
  before?: string;
  limit?: number;
} = {}): { receipts: WebhookReceiptSummary[]; nextCursor: string | null } {
  const limit = Math.min(100, Math.max(1, args.limit ?? 50));
  let names: string[];
  try { names = readdirSync(path.join(root(), 'summaries')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], nextCursor: null };
    throw err;
  }
  const all: WebhookReceiptSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const item = JSON.parse(readFileSync(path.join(root(), 'summaries', name), 'utf8')) as WebhookReceiptSummary;
      if (args.workflowId && item.workflowId !== args.workflowId) continue;
      if (args.triggerId && item.triggerId !== args.triggerId) continue;
      all.push(item);
    } catch (err) {
      log.warn('could not read receipt summary', { name, err });
    }
  }
  all.sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const cursor = args.before ? all.find((candidate) => candidate.id === args.before) : undefined;
  const filtered = !args.before ? all : !cursor ? [] : all.filter((item) =>
    item.receivedAt < cursor.receivedAt ||
    (item.receivedAt === cursor.receivedAt && item.id < cursor.id));
  const page = filtered.slice(0, limit).map((item) => {
    // If a detail rename succeeded but the summary rename failed, show the
    // authoritative state immediately. Startup reconciliation repairs the
    // disk index; this also repairs a transient error during a live process.
    try {
      const detail = getWebhookReceipt(item.id);
      if (detail && detail.updatedAt > item.updatedAt) {
        const fresh = summary(detail);
        try { writeAtomic(summaryPath(item.id), fresh); }
        catch (err) { log.warn('could not repair receipt summary', { id: item.id, err }); }
        return fresh;
      }
    } catch (err) {
      log.warn('could not read receipt detail while listing', { id: item.id, err });
    }
    return item;
  });
  return { receipts: page, nextCursor: filtered.length > limit ? page.at(-1)?.id ?? null : null };
}

/** Subscribe once in production. Exported so tests that clear the bus can rewire it. */
export function subscribeWebhookReceipts(bus: EventBus = eventBus): () => void {
  return bus.subscribe((ev) => {
    if (!ev.correlationId) return;
    try {
      if (ev.type === 'trigger_enqueued') {
        updateWebhookReceipt(ev.correlationId, {
          state: 'queued', queueId: ev.queueId, workflowId: ev.workflowId,
        });
      } else if (ev.type === 'trigger_started') {
        updateWebhookReceipt(ev.correlationId, {
          state: 'running', queueId: ev.queueId, runId: ev.runId, workflowId: ev.workflowId,
        });
      } else if (ev.type === 'trigger_dropped') {
        updateWebhookReceipt(ev.correlationId, {
          state: ev.reason === 'queue-full' ? 'rejected' : 'dropped', reason: ev.reason,
        });
      } else if (ev.type === 'trigger_removed') {
        updateWebhookReceipt(ev.correlationId, { state: 'removed', reason: ev.reason });
      } else if (ev.type === 'run_finished') {
        const current = getWebhookReceipt(ev.correlationId);
        if (!current || (current.runId && current.runId !== ev.runId) ||
            (ev.runId && current.supersededRunIds?.includes(ev.runId))) return;
        updateWebhookReceipt(ev.correlationId, {
          state: ev.status, runId: ev.runId, result: ev.scope,
          errorMessage: ev.errorMessage,
        });
      }
    } catch (err) {
      log.error('failed to update webhook receipt from event', { correlationId: ev.correlationId, err });
    }
  });
}

function ownerAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Reconcile receipts after run-marker recovery and before queued runs resume. */
export async function reconcileWebhookReceipts(): Promise<void> {
  let names: string[];
  try { names = readdirSync(root()); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const queued = new Map(listPersistedQueuedRuns().map((q) => [q.correlationId, q]));
  const markers = await listRunMarkers();
  const durable = listDurableRuns();
  const completed = new Map<string, RunSummary[]>();
  // listRuns is newest-first. Preserve that order and every attempt sharing a
  // correlation ID; a Map from id to one run would discard the newer retry.
  for (const run of await listRuns()) {
    if (!run.correlationId) continue;
    const group = completed.get(run.correlationId) ?? [];
    group.push(run);
    completed.set(run.correlationId, group);
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!isCorrelationId(id)) continue;
    try {
      const receipt = getWebhookReceipt(id);
      if (!receipt) continue;
      // The detail is authoritative. A crash between its rename and the
      // summary rename may leave the list stale or absent.
      if (!ownerAlive(receipt.serverPid)) {
        let saved: WebhookReceiptSummary | undefined;
        try { saved = JSON.parse(readFileSync(summaryPath(id), 'utf8')) as WebhookReceiptSummary; }
        catch { /* missing or torn summary */ }
        const expected = summary(receipt);
        if (JSON.stringify(saved) !== JSON.stringify(expected)) writeAtomic(summaryPath(id), expected);
      }
      if (ownerAlive(receipt.serverPid)) continue;

      // A queue file survives an earlier run's failed history in the narrow
      // crash window between engine start and queue-file removal. That queue
      // will be replayed next; its next result owns this delivery's status.
      const pending = queued.get(id);
      if (pending) {
        prepareQueuedReplay(receipt, pending.queueId, pending.workflow.id);
        continue;
      }
      if (terminal.has(receipt.state)) continue;

      const superseded = new Set(receipt.supersededRunIds ?? []);
      const currentRunId = receipt.runId;
      const completedRun = (completed.get(id) ?? []).find((run) =>
        currentRunId ? run.runId === currentRunId : !superseded.has(run.runId));
      const active = [...markers, ...durable].find((run) =>
        run.correlationId === id &&
        (currentRunId ? run.runId === currentRunId : !superseded.has(run.runId)));
      // When the receipt already names a run, its persisted result wins. With
      // no runId yet, a live marker/checkpoint may be the new retry while old
      // completed history shares the correlation ID, so prefer the active run.
      if (currentRunId && completedRun && receipt.workflowId) {
        const run = await getRun(receipt.workflowId, completedRun.runId);
        updateWebhookReceipt(id, {
          state: run.status, runId: run.runId, result: run.scope,
          errorMessage: run.errorMessage,
        });
        continue;
      }
      if (active) {
        updateWebhookReceipt(id, { state: 'running', runId: active.runId });
        continue;
      }
      if (!currentRunId && completedRun && receipt.workflowId) {
        const run = await getRun(receipt.workflowId, completedRun.runId);
        updateWebhookReceipt(id, {
          state: run.status, runId: run.runId, result: run.scope,
          errorMessage: run.errorMessage,
        });
        continue;
      }
      if (receipt.state === 'received') {
        updateWebhookReceipt(id, { state: 'rejected', reason: 'interrupted-before-enqueue' });
      } else if (receipt.state === 'queued') {
        updateWebhookReceipt(id, { state: 'dropped', reason: 'queue-unavailable-after-restart' });
      } else if (receipt.state === 'running') {
        updateWebhookReceipt(id, {
          state: 'failed', reason: 'run-unavailable-after-restart',
          errorMessage: 'The server stopped before this run could be recovered.',
        });
      }
    } catch (err) {
      log.warn('could not reconcile webhook receipt', { id, err });
    }
  }
}

// The event bus is process-global in Next dev mode. Recompiled modules replace
// their previous listener so one event writes one receipt transition.
declare global {
  // eslint-disable-next-line no-var
  var __infloopWebhookReceiptUnsub: (() => void) | undefined;
}
export function ensureWebhookReceiptSubscription(): void {
  globalThis.__infloopWebhookReceiptUnsub?.();
  globalThis.__infloopWebhookReceiptUnsub = subscribeWebhookReceipts();
}

ensureWebhookReceiptSubscription();
