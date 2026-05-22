import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET } from './route';

const TOKEN = 'test-metrics-token';

// Stash whatever the test process started with so each case can set the auth
// mode it needs and afterEach restores it.
const savedToken = process.env.INFLOOP_API_TOKEN;
const savedDataDir = process.env.INFLOOP_DATA_DIR;
let tmpDir: string;

beforeEach(() => {
  // Isolate the data-dir writability probe — run on every scrape to drive
  // `infloop_data_dir_writable` — from the real ~/.infinite-loop.
  tmpDir = mkdtempSync(join(tmpdir(), 'infinite-loop-metrics-'));
  process.env.INFLOOP_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = savedToken;
  if (savedDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = savedDataDir;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/metrics', { headers });
}

describe('GET /api/metrics', () => {
  it('answers 401 when gated and no credential is presented', async () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('serves Prometheus text to a Bearer-authed request', async () => {
    process.env.INFLOOP_API_TOKEN = TOKEN;
    const res = await GET(req({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('# TYPE infloop_runs_total counter');
    expect(body).toContain('# TYPE infloop_run_duration_seconds histogram');
    // Gauges sourced live from the engine / slot pool / trigger queue.
    expect(body).toContain('infloop_runs_active ');
    expect(body).toContain('infloop_slot_pool_capacity ');
    expect(body).toContain('infloop_queue_depth ');
    // Event-memory-budget gauges: aggregate buffered events + the ceiling.
    expect(body).toContain('infloop_event_buffer_events ');
    expect(body).toContain('infloop_event_buffer_limit ');
    // Data-dir readiness gauge — `1` here since tmpDir is writable.
    expect(body).toContain('infloop_data_dir_writable 1');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('serves metrics in open mode when no token is configured', async () => {
    delete process.env.INFLOOP_API_TOKEN;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('reports infloop_data_dir_writable 0 when the data dir is unwritable', async () => {
    // Same trick as the /api/health test: a data dir nested under a regular
    // file makes the probe's mkdir fail.
    delete process.env.INFLOOP_API_TOKEN;
    const blocker = join(tmpDir, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.INFLOOP_DATA_DIR = join(blocker, 'nested');

    const res = await GET(req());
    // /api/metrics itself still scrapes 200 — the unwritable state surfaces
    // only through this gauge, which is what InfiniteLoopDataDirNotWritable
    // alerts on.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('infloop_data_dir_writable 0');
  });
});
