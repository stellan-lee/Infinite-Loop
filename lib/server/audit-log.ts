/*
 * Append-only audit log for trust- and security-relevant events.
 *
 * Infinite Loop runs arbitrary code and spends API credits unattended —
 * triggered by webhooks and MCP when nobody is watching the console. This log
 * is its durable account of what it did: run lifecycle, auth attempts, trigger
 * CRUD, and webhook accept/reject decisions.
 *
 * Unlike run history (run-store.ts) — capped per workflow and silently pruned
 * — this log is append-only and bounded only by a generous size-based
 * rotation, and it also captures events that happen outside any run. One JSON
 * object per line (JSONL), matching the structured logger's format. See
 * specs/audit-log.md for the full design.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { auditDir } from './paths';
import { createLogger } from './logger';

const log = createLogger('audit-log');

export type AuditCategory = 'run' | 'auth' | 'trigger' | 'webhook';
export type AuditOutcome = 'success' | 'failure' | 'info';

export interface AuditEntry {
  /** ISO 8601 — stamped by `recordAudit`. */
  ts: string;
  category: AuditCategory;
  action: string;
  outcome: AuditOutcome;
  /** Coarse actor — never a credential, never a person. */
  actor?: string;
  /** Affected resource id (runId / triggerId). */
  target?: string;
  /** Small structured payload. MUST NOT contain secrets. */
  detail?: Record<string, unknown>;
}

/** A new audit entry, minus the `ts` that `recordAudit` stamps. */
export type AuditInput = Omit<AuditEntry, 'ts'>;

/* ─── files / config ─────────────────────────────────────────────────────── */

const CURRENT_FILE = 'audit.jsonl';

/** Filename of rotated generation `n` (1 = most recent rotation). */
function rotatedFile(n: number): string {
  return `audit.${n}.jsonl`;
}

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_FILES = 5;

/** Hard ceiling on one serialized line, so a pathological `detail` cannot
 *  bloat the file or tear across the OS atomic-append boundary. */
const MAX_LINE_BYTES = 8 * 1024;

/** Rotation threshold in bytes. Read per-call — matching `historyLimit()` and
 *  the logger — so an env change takes effect without a restart. */
function maxBytes(): number {
  const raw = process.env.INFLOOP_AUDIT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

/** Rotated generations to keep, excluding the current file. Minimum 1 — a
 *  smaller value would defeat the log's purpose. */
function maxFiles(): number {
  const raw = process.env.INFLOOP_AUDIT_MAX_FILES;
  if (!raw) return DEFAULT_MAX_FILES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_FILES;
  return Math.floor(n);
}

/* ─── write path ─────────────────────────────────────────────────────────── */

/**
 * Serializes every write. Each new write is chained onto the tail so lines
 * never interleave and a rotation never races an in-flight append from this
 * process. The `.catch` keeps the chain alive — and resolved — after a failed
 * write, so a single failure cannot wedge all later audit writes.
 */
let tail: Promise<void> = Promise.resolve();

/**
 * Record an audit entry. Best-effort and **never throws / never rejects** —
 * audit logging must never break a request or a run. The returned promise
 * resolves once the entry is on disk, or once a write failure has been logged
 * and swallowed.
 *
 * Route handlers should `await` this before returning their Response: a
 * promise left dangling past `return` is not guaranteed to complete. The
 * run-controller / crash-recovery hooks call it fire-and-forget — they run
 * inside the long-lived process, not a request about to return.
 */
export function recordAudit(input: AuditInput): Promise<void> {
  const entry: AuditEntry = { ts: new Date().toISOString(), ...input };
  const op = tail.then(() => writeEntry(entry)).catch((err) => {
    log.error('audit write failed', { err });
  });
  tail = op;
  return op;
}

/**
 * Await every audit write queued so far. Used by tests (await before any
 * read-back assertion — `tail` is a module-level singleton shared across
 * `bun test` files) and available for graceful shutdown.
 */
export function flushAudit(): Promise<void> {
  return tail;
}

/**
 * Serialize one entry to a single JSONL line (including the trailing `\n`).
 *
 * An oversized — or non-serializable (circular, BigInt) — `detail` is dropped
 * in favour of a truncation marker, so one pathological entry can neither
 * bloat the file nor be lost. The remaining fields are small, server-controlled
 * values, so the truncated form is always well within `MAX_LINE_BYTES`.
 */
function serializeLine(entry: AuditEntry): string {
  let body: string;
  try {
    body = JSON.stringify(entry);
    if (Buffer.byteLength(body) + 1 > MAX_LINE_BYTES) {
      body = JSON.stringify({ ...entry, detail: { _truncated: true } });
    }
  } catch {
    // A circular or otherwise non-serializable `detail` — degrade to the
    // truncation marker rather than dropping the entry entirely. The other
    // fields are plain strings, so this second stringify cannot throw.
    body = JSON.stringify({ ...entry, detail: { _truncated: true } });
  }
  return body + '\n';
}

/** Rotation check + append, as one atomic link in the `tail` chain. */
async function writeEntry(entry: AuditEntry): Promise<void> {
  const dir = auditDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, CURRENT_FILE);
  const line = serializeLine(entry);
  await rotateIfNeeded(dir, file, Buffer.byteLength(line));
  await fs.appendFile(file, line, 'utf8');
}

/**
 * Rotate when appending `incomingBytes` would push the current file past the
 * size cap: drop the oldest generation beyond the keep count, shift
 * `audit.N` → `audit.N+1` (highest-numbered first, so no generation clobbers
 * another), then move the current file to `audit.1`. The following append
 * recreates a fresh current file.
 */
async function rotateIfNeeded(
  dir: string,
  file: string,
  incomingBytes: number,
): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return; // no current file yet — nothing to rotate
  }
  if (size === 0 || size + incomingBytes <= maxBytes()) return;

  const keep = maxFiles();
  // Drop the oldest generation that would fall off the end.
  await fs.rm(path.join(dir, rotatedFile(keep)), { force: true });
  // Shift the surviving generations down, highest-numbered first.
  for (let n = keep - 1; n >= 1; n--) {
    try {
      await fs.rename(
        path.join(dir, rotatedFile(n)),
        path.join(dir, rotatedFile(n + 1)),
      );
    } catch {
      // That generation does not exist yet — skip.
    }
  }
  try {
    await fs.rename(file, path.join(dir, rotatedFile(1)));
  } catch (err) {
    // Could not rotate the current file — log and leave it; the append that
    // follows continues into the over-cap current file rather than losing
    // the entry. The next write retries the rotation.
    log.warn('audit log rotation failed', { err });
  }
}

/* ─── read path ──────────────────────────────────────────────────────────── */

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 2000;

function isAuditEntry(v: unknown): v is AuditEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.ts === 'string' &&
    typeof e.category === 'string' &&
    typeof e.action === 'string' &&
    typeof e.outcome === 'string'
  );
}

/** Read one JSONL file (oldest line first on disk) and return its entries
 *  newest-first. Torn / unparseable lines are skipped — same posture as
 *  run-store reading a torn record. */
async function readFileEntries(p: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: AuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (isAuditEntry(parsed)) out.push(parsed);
    } catch {
      // torn or partial line — skip
    }
  }
  return out;
}

/**
 * Read recent audit entries, newest-first. Reads the current file, then walks
 * back through rotated generations only as far as `limit` requires.
 *
 * Reads *outside* the `tail` write chain — a pure read needs no serialization,
 * and a read concurrent with an append is absorbed by the torn-line skip.
 */
export async function listAuditEntries(
  opts: { limit?: number } = {},
): Promise<AuditEntry[]> {
  const limit = clampLimit(opts.limit);
  const dir = auditDir();

  // Current file first — it holds the newest entries.
  const out: AuditEntry[] = await readFileEntries(path.join(dir, CURRENT_FILE));
  for (let n = 1; out.length < limit && n <= maxFiles(); n++) {
    const before = out.length;
    out.push(...(await readFileEntries(path.join(dir, rotatedFile(n)))));
    // Rotation shifts generations contiguously, so an empty/missing one means
    // there is nothing older — stop walking back.
    if (out.length === before) break;
  }
  return out.slice(0, limit);
}

/** Clamp a requested limit into `[1, MAX_READ_LIMIT]`; absent or non-finite
 *  falls back to the default. */
export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_READ_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > MAX_READ_LIMIT) return MAX_READ_LIMIT;
  return n;
}
