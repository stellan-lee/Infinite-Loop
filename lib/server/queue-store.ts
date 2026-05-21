/*
 * Disk persistence for the trigger queue.
 *
 * The TriggerQueue (trigger-queue.ts) holds queued-but-not-yet-started runs in
 * memory. A webhook or MCP trigger gets an HTTP 202 ack the moment its run is
 * enqueued — an explicit promise the work will run. If the process restarts
 * before the drain reaches that item — a hard crash, OR the routine
 * `docker compose up -d --build` deploy — an in-memory-only queue loses it
 * silently: no `failed` run record, no audit entry, nothing.
 *
 * This module mirrors each queued run to a small JSON file so the next boot can
 * re-enqueue the survivors (see crash-recovery.reconcileQueuedRuns). The file
 * covers the enqueue→start window; once a run starts, RunController's own
 * crash-recovery marker (run-store.ts) covers start→settle, so a successfully
 * persisted run stays tracked across its whole life.
 *
 * The one residual loss case: persistence is best-effort. If the disk write
 * itself fails (a full or read-only volume), `persistQueuedRun` swallows the
 * error rather than failing the webhook — that single item then degrades to
 * the pre-feature in-memory behavior and a restart loses it, observable only
 * as a `queue-store` warn log. Failing the ingress request over a transient
 * disk hiccup would be the worse trade; see `persistQueuedRun`.
 *
 * The pattern is the same as child-registry.ts: synchronous atomic write-then-
 * rename, a `serverPid` stamp so a port-fallback second instance never steals
 * the other's items, a shallow type guard, and torn/partial files skipped.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { queueDir } from './paths';
import { createLogger } from './logger';
import type { QueuedRun } from './trigger-queue';

const log = createLogger('queue-store');

/**
 * A queued run as stored on disk: the in-memory `QueuedRun` plus the pid of the
 * server that enqueued it. The pid lets the boot reconciler skip an item still
 * owned by a co-running second instance (port fallback allows two servers on
 * one data dir).
 */
export interface PersistedQueuedRun extends QueuedRun {
  serverPid: number;
}

function queueFile(queueId: string): string {
  return path.join(queueDir(), `${queueId}.json`);
}

/**
 * Mirror one queued run to disk. Synchronous + best-effort, exactly like
 * child-registry's `writePidFile`: `enqueue()` is synchronous and the 202 ack
 * follows it, so the file must land before `enqueue()` returns; and a disk
 * hiccup must not fail the enqueue — the only cost is that this one item is not
 * recoverable if the server then crashes (i.e. it degrades to the pre-feature
 * in-memory behavior for that single item).
 */
export function persistQueuedRun(item: QueuedRun): void {
  const record: PersistedQueuedRun = { ...item, serverPid: process.pid };
  try {
    mkdirSync(queueDir(), { recursive: true });
    const target = queueFile(item.queueId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    log.warn('failed to persist queued run', { queueId: item.queueId, err });
  }
}

/**
 * Remove one queued run's file. `force` makes a missing file a no-op, so it is
 * safe to call more than once for the same item (the drain does exactly that).
 */
export function removeQueuedRun(queueId: string): void {
  try {
    rmSync(queueFile(queueId), { force: true });
  } catch {
    // best effort
  }
}

// Shallow, like child-registry's `isChildPidRecord`: `workflow` is only checked
// to be an object carrying a string `id`. That is deliberate — after restore,
// drain() re-loads the workflow fresh by id (loadWorkflow), so only `.id` is
// ever consumed from the persisted snapshot; a deep workflow check would buy
// nothing. `resolvedInputs`, by contrast, cannot be re-derived (the webhook
// body is gone) and is the field that genuinely justifies a full-object file.
function isPersistedQueuedRun(v: unknown): v is PersistedQueuedRun {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.queueId === 'string' &&
    typeof r.triggerId === 'string' &&
    typeof r.receivedAt === 'number' &&
    typeof r.serverPid === 'number' &&
    !!r.workflow &&
    typeof r.workflow === 'object' &&
    typeof (r.workflow as Record<string, unknown>).id === 'string' &&
    !!r.resolvedInputs &&
    typeof r.resolvedInputs === 'object'
  );
}

/**
 * Read every persisted queued run. Used once at boot by the reconciler.
 * Torn/unparseable files are skipped; leftover `.tmp` files from a write that a
 * crash interrupted are unlinked here — the queue dir has no other pruning
 * pass, so without this they would accumulate forever.
 */
export function listPersistedQueuedRuns(): PersistedQueuedRun[] {
  let names: string[];
  try {
    names = readdirSync(queueDir());
  } catch {
    return []; // directory absent — nothing was ever queued
  }
  const out: PersistedQueuedRun[] = [];
  for (const name of names) {
    const full = path.join(queueDir(), name);
    if (name.endsWith('.tmp')) {
      try {
        rmSync(full, { force: true });
      } catch {
        // best effort
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
      if (isPersistedQueuedRun(parsed)) out.push(parsed);
    } catch {
      // skip torn/unreadable file
    }
  }
  return out;
}
