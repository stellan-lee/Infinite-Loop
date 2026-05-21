import path from 'node:path';
import os from 'node:os';

export function dataDir(): string {
  return (
    process.env.INFLOOP_DATA_DIR || path.join(os.homedir(), '.infinite-loop')
  );
}

export function triggersDir(): string {
  return (
    process.env.INFLOOP_TRIGGERS_DIR || path.join(dataDir(), 'triggers')
  );
}

export function connectionsDir(): string {
  return (
    process.env.INFLOOP_CONNECTIONS_DIR || path.join(dataDir(), 'connections')
  );
}

/**
 * Directory holding one JSON file per live detached child process. Survives a
 * crash so the next boot can reap orphaned provider CLIs. See child-registry.ts
 * and crash-recovery.ts. Derived from `dataDir()` (no separate env var) so the
 * standard `INFLOOP_DATA_DIR` test override isolates it for free.
 */
export function pidsDir(): string {
  return path.join(dataDir(), 'pids');
}

/**
 * Directory holding one marker file per in-flight run. A leftover marker after
 * a crash is reconciled into a `failed` history record on the next boot. See
 * run-store.ts and crash-recovery.ts.
 *
 * Derived from `dataDir()`, not from `INFLOOP_RUNS_DIR`: a marker is transient
 * operational state, not run history, so it stays with the data dir even when
 * persisted run records are pointed elsewhere. The `INFLOOP_DATA_DIR` test
 * override isolates it for free.
 */
export function activeRunsDir(): string {
  return path.join(dataDir(), 'active-runs');
}
