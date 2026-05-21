import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '@/package.json';
import { GET } from './route';

interface HealthBody {
  status: string;
  version?: string;
  uptimeSeconds?: number;
  timestamp?: string;
  error?: string;
}

let tmpDir: string;
const savedDataDir = process.env.INFLOOP_DATA_DIR;

beforeEach(() => {
  // Isolate the writability probe from the real ~/.infinite-loop.
  tmpDir = mkdtempSync(join(tmpdir(), 'infinite-loop-health-'));
  process.env.INFLOOP_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = savedDataDir;
  delete process.env.INFLOOP_API_TOKEN;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('GET /api/health', () => {
  it('returns 200 with the health payload when the data dir is writable', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.version).toBe(pkg.version);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds ?? -1).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(body.timestamp ?? ''))).toBe(false);
  });

  it('is reachable without authentication even when a token is configured', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret-token';
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it('returns 503 degraded when the data dir is not writable', async () => {
    // Point the data dir at a path nested under a regular file — mkdir fails.
    const blocker = join(tmpDir, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.INFLOOP_DATA_DIR = join(blocker, 'nested');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.error).toBe('data directory is not writable');
    // Still reports version/uptime so an operator can identify the instance.
    expect(body.version).toBe(pkg.version);
  });
});
