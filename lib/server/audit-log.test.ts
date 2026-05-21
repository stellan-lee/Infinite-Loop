import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { auditDir } from './paths';
import {
  clampLimit,
  flushAudit,
  listAuditEntries,
  recordAudit,
} from './audit-log';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

/** Stash an env var, then set or delete it. `restore` puts every stash back. */
function stash(name: string, value?: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-audit-'));
  // A fresh data dir per test gives the audit log a clean slate. `tail` is a
  // module-level singleton, but afterEach drains it before the env changes.
  stash('INFLOOP_DATA_DIR', tmpDir);
  stash('INFLOOP_AUDIT_MAX_BYTES');
  stash('INFLOOP_AUDIT_MAX_FILES');
});

afterEach(async () => {
  await flushAudit();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function readLines(file: string): Promise<string[]> {
  const raw = await fsp.readFile(file, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
}

describe('recordAudit + listAuditEntries', () => {
  it('writes an entry and reads it back', async () => {
    await recordAudit({ category: 'auth', action: 'login', outcome: 'success' });
    const entries = await listAuditEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].category).toBe('auth');
    expect(entries[0].action).toBe('login');
    expect(entries[0].outcome).toBe('success');
  });

  it('stamps an ISO-8601 ts', async () => {
    await recordAudit({ category: 'run', action: 'started', outcome: 'info' });
    const [entry] = await listAuditEntries();
    expect(typeof entry.ts).toBe('string');
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
  });

  it('returns entries newest-first', async () => {
    await recordAudit({ category: 'run', action: 'started', outcome: 'info' });
    await recordAudit({ category: 'run', action: 'finished', outcome: 'success' });
    const entries = await listAuditEntries();
    expect(entries.map((e) => e.action)).toEqual(['finished', 'started']);
  });

  it('persists one JSON object per line at audit/audit.jsonl', async () => {
    await recordAudit({ category: 'auth', action: 'login', outcome: 'success' });
    await flushAudit();
    const lines = await readLines(path.join(auditDir(), 'audit.jsonl'));
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).action).toBe('login');
  });

  it('preserves actor, target and detail', async () => {
    await recordAudit({
      category: 'trigger',
      action: 'created',
      outcome: 'success',
      actor: 'api-token',
      target: 'trg-123',
      detail: { name: 'My Trigger' },
    });
    const [entry] = await listAuditEntries();
    expect(entry.actor).toBe('api-token');
    expect(entry.target).toBe('trg-123');
    expect(entry.detail).toEqual({ name: 'My Trigger' });
  });
});

describe('serialized writes', () => {
  it('does not interleave or drop concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recordAudit({ category: 'run', action: `a${i}`, outcome: 'info' }),
      ),
    );
    const lines = await readLines(path.join(auditDir(), 'audit.jsonl'));
    expect(lines.length).toBe(50);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('rotation', () => {
  it('rotates the current file once it exceeds the size cap', async () => {
    stash('INFLOOP_AUDIT_MAX_BYTES', '200');
    for (let i = 0; i < 20; i++) {
      await recordAudit({ category: 'run', action: `step-${i}`, outcome: 'info' });
    }
    const files = await fsp.readdir(auditDir());
    expect(files).toContain('audit.jsonl');
    expect(files).toContain('audit.1.jsonl');
  });

  it('keeps at most INFLOOP_AUDIT_MAX_FILES rotated generations', async () => {
    stash('INFLOOP_AUDIT_MAX_BYTES', '200');
    stash('INFLOOP_AUDIT_MAX_FILES', '2');
    for (let i = 0; i < 80; i++) {
      await recordAudit({ category: 'run', action: `s${i}`, outcome: 'info' });
    }
    const rotated = (await fsp.readdir(auditDir())).filter(
      (f) => /^audit\.\d+\.jsonl$/.test(f),
    );
    expect(rotated.length).toBeLessThanOrEqual(2);
    expect(rotated).not.toContain('audit.3.jsonl');
  });

  it('reads across rotated generations, newest-first', async () => {
    stash('INFLOOP_AUDIT_MAX_BYTES', '200');
    for (let i = 0; i < 20; i++) {
      await recordAudit({ category: 'run', action: `n${i}`, outcome: 'info' });
    }
    const entries = await listAuditEntries({ limit: 100 });
    // The newest entry survives in the current file; entries span rotations.
    expect(entries[0].action).toBe('n19');
    expect(entries.length).toBeGreaterThan(2);
    // Strictly descending by ts (newest-first) across the rotation boundary.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].ts >= entries[i].ts).toBe(true);
    }
  });
});

describe('limit handling', () => {
  it('caps the number of returned entries', async () => {
    for (let i = 0; i < 10; i++) {
      await recordAudit({ category: 'run', action: `x${i}`, outcome: 'info' });
    }
    const entries = await listAuditEntries({ limit: 3 });
    expect(entries.length).toBe(3);
    expect(entries[0].action).toBe('x9');
  });

  it('clampLimit bounds the value into [1, 2000] with a default', () => {
    expect(clampLimit(undefined)).toBe(200);
    expect(clampLimit(Number.NaN)).toBe(200);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(99999)).toBe(2000);
    expect(clampLimit(10.7)).toBe(10);
  });
});

describe('resilience', () => {
  it('skips torn / unparseable lines on read', async () => {
    await recordAudit({ category: 'auth', action: 'login', outcome: 'success' });
    await flushAudit();
    const file = path.join(auditDir(), 'audit.jsonl');
    await fsp.appendFile(file, '{ this is not json\n');
    await fsp.appendFile(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        category: 'run',
        action: 'ok',
        outcome: 'info',
      }) + '\n',
    );
    const entries = await listAuditEntries();
    expect(entries.map((e) => e.action)).toEqual(['ok', 'login']);
  });

  it('truncates an oversized detail rather than writing a huge line', async () => {
    await recordAudit({
      category: 'run',
      action: 'huge',
      outcome: 'info',
      detail: { blob: 'x'.repeat(20_000) },
    });
    const [entry] = await listAuditEntries();
    expect(entry.detail).toEqual({ _truncated: true });
    const lines = await readLines(path.join(auditDir(), 'audit.jsonl'));
    expect(Buffer.byteLength(lines[0])).toBeLessThan(8 * 1024);
  });

  it('degrades a non-serializable detail to a truncation marker', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      recordAudit({
        category: 'run',
        action: 'circular',
        outcome: 'info',
        detail: circular,
      }),
    ).resolves.toBeUndefined();
    const [entry] = await listAuditEntries();
    expect(entry.action).toBe('circular');
    expect(entry.detail).toEqual({ _truncated: true });
  });

  it('never rejects when the audit directory cannot be created', async () => {
    // Point the data dir at a path nested under a regular file — mkdir fails.
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    stash('INFLOOP_DATA_DIR', path.join(blocker, 'nested'));
    await expect(
      recordAudit({ category: 'run', action: 'x', outcome: 'info' }),
    ).resolves.toBeUndefined();
    expect(await listAuditEntries()).toEqual([]);
  });
});
