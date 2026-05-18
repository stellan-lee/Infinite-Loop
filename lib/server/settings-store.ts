/*
 * Settings store — persists user-editable engine knobs.
 *
 * Today: only `maxConcurrentRuns`. The on-disk shape is enveloped
 * (`{ settings: { ... } }`) so future knobs do not force a v2 route.
 *
 * Writes use a tmp-write + rename for atomicity (matches the pattern in
 * run-store). A single-process async mutex serializes concurrent PUTs so
 * in-memory state and on-disk state cannot diverge under racing requests.
 *
 * On boot, the env var `INFLOOP_MAX_CONCURRENT_RUNS` provides the default
 * if no settings file exists. The on-disk value, when present, overrides
 * the env var.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { dataDir } from './paths';

export interface PersistedSettings {
  maxConcurrentRuns?: number;
}

const DEFAULT_MAX_CONCURRENT_RUNS = 4;

function settingsPath(): string {
  return path.join(dataDir(), 'settings.json');
}

function readMaxConcurrentFromEnv(): number {
  const raw = process.env.INFLOOP_MAX_CONCURRENT_RUNS;
  if (!raw) return DEFAULT_MAX_CONCURRENT_RUNS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_RUNS;
  return n;
}

/** Read settings from disk; falls back to env defaults when the file is
 *  absent or malformed. Never throws — settings persistence is non-critical. */
export async function loadSettings(): Promise<PersistedSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object') {
      const s = parsed.settings as Record<string, unknown>;
      const out: PersistedSettings = {};
      if (typeof s.maxConcurrentRuns === 'number' && Number.isFinite(s.maxConcurrentRuns) && s.maxConcurrentRuns > 0) {
        out.maxConcurrentRuns = Math.floor(s.maxConcurrentRuns);
      }
      return out;
    }
  } catch {
    // Missing or malformed; return defaults.
  }
  return {};
}

/** Resolve the effective `maxConcurrentRuns`: persisted value if set,
 *  otherwise the env-var-or-default boot ceiling. */
export async function effectiveMaxConcurrentRuns(): Promise<number> {
  const persisted = await loadSettings();
  if (persisted.maxConcurrentRuns) return persisted.maxConcurrentRuns;
  return readMaxConcurrentFromEnv();
}

let mutex: Promise<void> = Promise.resolve();

/** Atomically persist `settings` to disk. Serializes against concurrent
 *  writes via an async mutex so two simultaneous PUT requests cannot
 *  produce torn state. The tmp+rename pattern matches run-store. */
export async function saveSettings(settings: PersistedSettings): Promise<void> {
  const run = async () => {
    const dir = dataDir();
    await fs.mkdir(dir, { recursive: true });
    const final = settingsPath();
    const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify({ settings }, null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, final);
  };
  // Chain on the mutex so PUTs serialize.
  mutex = mutex.then(run, run);
  return mutex;
}
