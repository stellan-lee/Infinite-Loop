import { afterEach, describe, expect, it } from 'bun:test';
import { GET } from './route';

const TOKEN = 'test-metrics-token';

// Stash whatever the test process started with so each case can set the auth
// mode it needs and afterEach restores it.
const savedToken = process.env.INFLOOP_API_TOKEN;
afterEach(() => {
  if (savedToken === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = savedToken;
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
    expect(body.endsWith('\n')).toBe(true);
  });

  it('serves metrics in open mode when no token is configured', async () => {
    delete process.env.INFLOOP_API_TOKEN;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });
});
