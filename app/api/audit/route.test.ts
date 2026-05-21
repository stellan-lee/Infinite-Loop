import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GET } from './route';
import { flushAudit, recordAudit } from '@/lib/server/audit-log';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

function stash(name: string, value?: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-audit-route-'));
  stash('INFLOOP_DATA_DIR', tmpDir);
  stash('INFLOOP_API_TOKEN');
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

function req(url = 'http://localhost/api/audit', headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

interface AuditBody {
  entries: { category: string; action: string }[];
}

describe('GET /api/audit', () => {
  it('401s when a token is configured and no credential is sent', async () => {
    stash('INFLOOP_API_TOKEN', 'secret');
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns entries newest-first for an authenticated request', async () => {
    stash('INFLOOP_API_TOKEN', 'secret');
    await recordAudit({ category: 'auth', action: 'login', outcome: 'success' });
    await recordAudit({ category: 'run', action: 'started', outcome: 'info' });

    const res = await GET(req('http://localhost/api/audit', { authorization: 'Bearer secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditBody;
    expect(body.entries.map((e) => e.action)).toEqual(['started', 'login']);
  });

  it('respects the limit query param', async () => {
    for (let i = 0; i < 5; i++) {
      await recordAudit({ category: 'run', action: `r${i}`, outcome: 'info' });
    }
    const res = await GET(req('http://localhost/api/audit?limit=2'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditBody;
    expect(body.entries.length).toBe(2);
  });

  it('is reachable in open mode (no token configured)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditBody;
    expect(Array.isArray(body.entries)).toBe(true);
  });
});
