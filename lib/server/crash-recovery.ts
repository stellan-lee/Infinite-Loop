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
 * Both functions run once at the very start of boot — before Next.js prepares
 * and long before the HTTP server listens, so no child of the new server can
 * yet exist to be confused with a stale PID file. They reap the orphan
 * process groups and convert leftover run markers into `failed` history
 * records.
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
import { createLogger } from './logger';
import { recordAudit } from './audit-log';

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
      });
      reconciled++;
      // Record the interrupted run in the audit log too: it left a
      // `run/started` entry with no `run/finished`, and this closes that gap.
      void recordAudit({
        category: 'run',
        action: 'finished',
        outcome: 'failure',
        actor: 'system',
        target: m.runId,
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
