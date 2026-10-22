/*
 * Crash recovery — boot-time cleanup after a previous server died abnormally.
 *
 * A graceful shutdown (SIGINT/SIGTERM/SIGHUP) runs server.ts's handlers, which
 * reap children and persist runs. A hard crash — OOM-kill, `kill -9`, a panic,
 * power loss — skips all of that and opens two leaks:
 *
 *   1. Orphaned process groups. Provider/script children are spawned
 *      `detached: true` (own process group) so per-run cancel can kill
 *      grandchildren. The flip side: they do NOT die with the server. An
 *      orphaned `claude` CLI inside a loop keeps running — and keeps spending
 *      API credits — invisibly. The in-memory registry that would have reaped
 *      it died with the process; only the on-disk PID records survive
 *      (child-registry.ts).
 *
 *   2. Lost runs. A run reaches history only at settle, so a run interrupted
 *      by the crash leaves no trace. Only its on-disk marker survives
 *      (run-store.ts).
 *
 *   3. Lost queued runs. A run accepted by a trigger (HTTP 202) but not yet
 *      started lives only in the in-memory trigger queue. This one is not
 *      crash-specific — even a graceful restart (a `docker compose` redeploy)
 *      drops it, since nothing drains the queue at shutdown. queue-store.ts
 *      mirrors each queued run to disk so the survivors can be re-enqueued.
 *
 * All three functions run once at the very start of boot — before Next.js
 * prepares and long before the HTTP server listens, so no child of the new
 * server can yet exist to be confused with a stale PID file. They reap the
 * orphan process groups, convert leftover run markers into `failed` history
 * records, and re-enqueue persisted queued runs.
 *
 * Multi-instance: port fallback (server.ts) lets two servers run at once. Both
 * artifacts carry the `serverPid` that wrote them; recovery skips anything
 * still owned by a different, live server, so one instance never reaps the
 * other's work.
 *
 * Known limitation: if a crashed server's PID is itself recycled to an
 * unrelated live process before the next boot, recovery treats that server as
 * still alive and skips its leftovers (the orphan is not reaped). This is
 * fail-safe — a missed reap, never a wrong kill — and unlikely in the short
 * crash→restart window, so it is documented rather than solved for v1.
 */

import { listDurableRuns } from './durable-run';
import { execFileSync } from 'node:child_process';
import {
  listChildPidRecords,
  removeChildPidFile,
} from './child-registry';
import {
  listRunMarkers,
  removeRunMarker,
  runExists,
  saveRun,
} from './run-store';
import { listPersistedQueuedRuns } from './queue-store';
import type { QueuedRun, QueueRestoreTarget } from './trigger-queue';
import { createLogger } from './logger';
import { recordAudit } from './audit-log';
import { newCorrelationId } from './correlation';
import { metrics } from './metrics';

const log = createLogger('crash-recovery');

/**
 * Tolerance when matching a live process's start time against a PID record's
 * `spawnedAt`. Absorbs `ps`'s one-second resolution and the small gap between
 * recording `spawnedAt` and the kernel actually starting the process. A
 * genuine orphan started essentially at `spawnedAt`; a recycled PID — which
 * necessarily started only after the original orphan exited — sits far
 * outside this window for any child that ran longer than a few seconds.
 */
const START_TIME_TOLERANCE_MS = 5_000;

/** True if `pid` names a live process. EPERM (exists, not signalable by us)
 *  still counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Parse a `ps` etime value (`[[DD-]HH:]MM:SS`) into elapsed milliseconds.
 * Returns null for an unrecognized format. Exported for unit testing.
 */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

type PidProbe =
  | { state: 'gone' }
  | { state: 'alive'; startedAt: number }
  /** `ps` is unavailable — identity can't be verified on this platform. */
  | { state: 'unknown' };

let psUnavailableLogged = false;

/** Probe a pid via `ps`: is it live, and (if so) when did it start? */
function probePid(pid: number): PidProbe {
  let etime: string;
  try {
    etime = execFileSync('ps', ['-p', String(pid), '-o', 'etime='], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (e.code === 'ENOENT') {
      // `ps` binary itself is missing — can't verify identity here.
      if (!psUnavailableLogged) {
        log.warn('`ps` unavailable; orphan PID-reuse protection disabled');
        psUnavailableLogged = true;
      }
      return { state: 'unknown' };
    }
    // `ps` ran and exited non-zero → no process with that pid.
    if (typeof e.status === 'number') return { state: 'gone' };
    // Anything else (timeout, EACCES, killed mid-probe) is inconclusive —
    // stay 'unknown' so a transient hiccup doesn't abandon a real orphan.
    return { state: 'unknown' };
  }
  if (etime.length === 0) return { state: 'gone' };
  const ageMs = parseEtime(etime);
  if (ageMs == null) return { state: 'unknown' };
  return { state: 'alive', startedAt: Date.now() - ageMs };
}

/** SIGKILL a process group, falling back to the bare pid. Returns whether a
 *  signal was delivered. Orphans get SIGKILL directly — they are detached
 *  from everything and have no salvageable state, and a SIGTERM-then-timer
 *  dance would reopen a PID-reuse window. */
function killOrphanGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false; // raced us — already gone
    }
  }
}

/**
 * Kill process groups orphaned by a previous server crash. Synchronous and
 * best-effort; call once at boot before the HTTP server listens.
 *
 * PRECONDITION: must run before this server's first `registerChild`. The
 * `serverPid === process.pid` branch below treats a PID record bearing our own
 * pid as a crashed predecessor that recycled it — sound only while we have
 * spawned no children yet. Running it after a spawn site could SIGKILL this
 * server's own live child's process group. server.ts satisfies this by calling
 * it before `app.prepare()` and long before the HTTP server listens.
 */
export function reapOrphanProcesses(): void {
  let killed = 0;

  for (const rec of listChildPidRecords()) {
    // Owned by a different, currently-live server (a port-fallback second
    // instance) — its children are not ours to touch. `serverPid` equal to
    // our own pid means a *previous* server reused this pid: at boot we own
    // no children yet, so that record's child is genuinely an orphan.
    if (rec.serverPid !== process.pid && isProcessAlive(rec.serverPid)) {
      continue;
    }

    const probe = probePid(rec.pid);
    if (probe.state === 'gone') {
      removeChildPidFile(rec.pid);
      continue;
    }
    if (
      probe.state === 'alive' &&
      probe.startedAt > rec.spawnedAt + START_TIME_TOLERANCE_MS
    ) {
      // Live, but it started well after we recorded the spawn: the original
      // child exited and this pid was recycled to an unrelated process.
      removeChildPidFile(rec.pid);
      continue;
    }
    // 'alive' with a matching start time, or 'unknown' (no `ps` to check) — reap.
    if (killOrphanGroup(rec.pid)) killed++;
    removeChildPidFile(rec.pid);
  }

  if (killed > 0) {
    log.info('reaped orphaned process group(s) from a previous server', {
      count: killed,
    });
  }
}

/**
 * Convert run markers left behind by a crashed server into `failed` history
 * records, so an interrupted run is not silently lost. Best-effort; call once
 * at boot.
 */
export async function reconcileInterruptedRuns(): Promise<void> {
  let reconciled = 0;
  const resumable = new Set(listDurableRuns().map(run => run.runId));

  for (const m of await listRunMarkers()) {
    // Still owned by a different, live (second-instance) server — leave it.
    if (m.serverPid !== process.pid && isProcessAlive(m.serverPid)) {
      continue;
    }
    // The run actually settled — marker removal lost a race with a crash, or
    // saveRun failed once and kept the marker. The real terminal record wins.
    if (await runExists(m.workflowId, m.runId)) {
      await removeRunMarker(m.runId);
      continue;
    }
    if (resumable.has(m.runId)) continue;
    try {
      await saveRun({
        runId: m.runId,
        workflowId: m.workflowId,
        workflowName: m.workflowName,
        status: 'failed',
        startedAt: m.startedAt,
        // The actual crash time is unknowable; a 0ms duration signals
        // "interrupted" rather than inventing a misleading wall-clock span.
        finishedAt: m.startedAt,
        durationMs: 0,
        scope: {},
        errorMessage:
          'run interrupted: the server stopped or crashed before this run finished',
        events: [],
        // Carry the trace link onto the synthesized failure record. Absent on
        // markers written before the correlation-id field existed.
        correlationId: m.correlationId,
      });
      reconciled++;
      // Fold this crash-interrupted run into the process-lifetime metrics.
      // It never went through RunController's settle path (recordRunSettled),
      // so without this `infloop_runs_total{status="failed"}` would silently
      // undercount hard crashes — the worst failure mode, and the one an
      // operator most needs their failure alert to catch. See metrics.ts.
      metrics.recordCrashRecoveredRun();
      // Record the interrupted run in the audit log too: it left a
      // `run/started` entry with no `run/finished`, and this closes that gap.
      void recordAudit({
        category: 'run',
        action: 'finished',
        outcome: 'failure',
        actor: 'system',
        target: m.runId,
        correlationId: m.correlationId,
        detail: {
          workflowId: m.workflowId,
          status: 'failed',
          reason: 'crash-recovered',
        },
      });
    } catch (err) {
      // Keep the marker so the next boot retries.
      log.warn('failed to reconcile run', { runId: m.runId, err });
      continue;
    }
    await removeRunMarker(m.runId);
  }

  if (reconciled > 0) {
    log.info('marked interrupted run(s) as failed', { count: reconciled });
  }
}

/**
 * Re-enqueue queued runs left behind by a previous server, so a trigger that
 * was acknowledged (HTTP 202) before a restart still runs. A queued run lives
 * only in memory until the drain starts it; queue-store.ts mirrors each to
 * disk, and this turns the survivors back into live queue entries.
 *
 * The queue is passed in rather than imported so this module stays free of the
 * trigger queue's construction graph (engine, executors); server.ts owns that
 * wiring and supplies the singleton.
 *
 * PRECONDITION: run after `reapOrphanProcesses()`. This kicks the drain, which
 * may spawn provider children; the reaper must have already finished so it
 * cannot mistake one of those fresh children for a stale orphan.
 *
 * Best-effort; call once at boot. A run re-enqueued here that had in fact
 * already started before the crash (the queue file outlived its removal by a
 * sub-millisecond window) would run a second time — a bounded, visible
 * duplicate, and the deliberate trade for never silently losing one.
 *
 * Multi-instance: the `serverPid` skip below means a second instance (port
 * fallback) never *steals* an item still genuinely queued under a live peer.
 * It can still hit the same bounded-duplication window above — booting in the
 * instant between the peer's `engineStart` and its queue-file removal — which
 * is the identical, accepted trade, not a new failure mode.
 */
export function reconcileQueuedRuns(queue: QueueRestoreTarget): void {
  const survivors: QueuedRun[] = [];
  for (const item of listPersistedQueuedRuns()) {
    // Still owned by a different, live (port-fallback second-instance) server —
    // leave it for that instance's own queue and drain to handle.
    if (item.serverPid !== process.pid && isProcessAlive(item.serverPid)) {
      continue;
    }
    survivors.push({
      queueId: item.queueId,
      workflow: item.workflow,
      resolvedInputs: item.resolvedInputs,
      triggerId: item.triggerId,
      // Backfill is load-bearing for type soundness: `QueuedRun.correlationId`
      // is a required `string`, but `isPersistedQueuedRun` does not check it,
      // so a file written before this field existed reaches here with it
      // `undefined`. Minting one here keeps the trace alive (a fresh id, since
      // the original is unrecoverable) and keeps the required type honest.
      correlationId: item.correlationId ?? newCorrelationId(),
      receivedAt: item.receivedAt,
    });
  }

  if (survivors.length === 0) return;

  queue.restore(survivors);
  void queue.drain();
  log.info('re-enqueued queued run(s) from a previous server', {
    count: survivors.length,
  });
}
