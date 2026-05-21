/**
 * Process group registry for `detached: true` child spawns.
 *
 * The runner/script/list-cli-agents code paths spawn children with
 * `detached: true` so that on per-run cancel or timeout we can kill the whole
 * group (e.g. a wrapper shell plus its grandchildren). The same setting means
 * SIGINT to the server's process group doesn't reach those children — Ctrl+C
 * would otherwise leave provider CLIs running as orphans. Each spawn site
 * registers its pid here so server.ts can reap the lot on shutdown.
 *
 * Out of scope: non-detached spawns (e.g. `exec()` in conditions/command.ts)
 * stay in the server's process group and die with it on SIGINT — they don't
 * need to register here.
 *
 * Crash recovery: the in-memory `Set` only protects against a *graceful*
 * shutdown. A hard crash (OOM-kill, `kill -9`, panic, power loss) skips the
 * shutdown handlers entirely, and a detached child does NOT die with its
 * parent — so an orphaned `claude` CLI keeps running and keeps spending API
 * credits, invisibly. To close that, every registered pid is also mirrored to
 * a small JSON file under `pidsDir()`; the files survive the crash and let the
 * next server boot find and reap the orphans (see crash-recovery.ts).
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
import { pidsDir } from './paths';

/** On-disk record of one live detached child. */
export interface ChildPidRecord {
  /** PID of the detached child. It is also its own process-group id (the
   *  child is the group leader), so `kill(-pid, ...)` signals the group. */
  pid: number;
  /** PID of the server process that spawned it. Lets the boot reaper tell a
   *  crashed predecessor's orphans apart from a second, still-running
   *  instance's live children (port fallback allows two servers at once). */
  serverPid: number;
  /** Resolved binary path/name — purely for log readability when reaped. */
  bin: string;
  /** Wall-clock spawn time. The boot reaper compares this against the live
   *  process's age (`ps -o etime`) to reject a recycled PID. */
  spawnedAt: number;
}

const active = new Set<number>();

function pidFile(pid: number): string {
  return path.join(pidsDir(), `${pid}.json`);
}

/** Mirror a registered pid to disk. Best-effort: a spawn must never fail
 *  because the PID file could not be written — the only cost is that this one
 *  child can't be reaped if the server then crashes. Synchronous so the file
 *  is on disk before the caller proceeds, and so it can never land *after* a
 *  racing `unregisterChild` and resurrect a stale file. */
function writePidFile(pid: number, bin: string): void {
  const record: ChildPidRecord = {
    pid,
    serverPid: process.pid,
    bin,
    spawnedAt: Date.now(),
  };
  try {
    mkdirSync(pidsDir(), { recursive: true });
    const target = pidFile(pid);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf8');
    renameSync(tmp, target);
  } catch {
    // best effort — see docstring
  }
}

export function registerChild(pid: number, meta?: { bin?: string }): void {
  active.add(pid);
  writePidFile(pid, meta?.bin ?? '');
}

export function unregisterChild(pid: number): void {
  active.delete(pid);
  removeChildPidFile(pid);
}

/** Remove one child's PID file. `force: true` makes a missing file a no-op,
 *  which also absorbs the unlink race between a graceful shutdown and a
 *  concurrent second instance's boot reaper. */
export function removeChildPidFile(pid: number): void {
  try {
    rmSync(pidFile(pid), { force: true });
  } catch {
    // best effort
  }
}

/** Remove the PID files of every still-tracked child. Called from the graceful
 *  shutdown path: those children are about to be killed, so their files are
 *  moot — dropping them keeps the next boot's reaper from doing pointless
 *  work. (A hard crash skips this; that is exactly what the reaper is for.) */
export function clearChildPidFiles(): void {
  for (const pid of active) removeChildPidFile(pid);
}

/** Read every PID record currently on disk. Used once at boot by the orphan
 *  reaper. Unparseable/partial files are skipped. */
export function listChildPidRecords(): ChildPidRecord[] {
  let names: string[];
  try {
    names = readdirSync(pidsDir());
  } catch {
    return []; // directory absent — nothing was ever spawned
  }
  const out: ChildPidRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.json.tmp')) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(pidsDir(), name), 'utf8'),
      ) as unknown;
      if (isChildPidRecord(parsed)) out.push(parsed);
    } catch {
      // skip torn/unreadable file
    }
  }
  return out;
}

function isChildPidRecord(v: unknown): v is ChildPidRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.pid === 'number' &&
    typeof r.serverPid === 'number' &&
    typeof r.bin === 'string' &&
    typeof r.spawnedAt === 'number'
  );
}

export function activeChildCount(): number {
  return active.size;
}

/** Send `signal` to every tracked child's process group (falls back to the
 * pid alone if the group kill fails). Best-effort: errors are swallowed
 * because a child may have already exited between registration and the kill. */
export function killAllChildren(signal: NodeJS.Signals): void {
  for (const pid of active) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  }
}
