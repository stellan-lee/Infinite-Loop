import { afterEach, describe, expect, it } from 'bun:test';
import pkg from '@/package.json';
import { GET } from './route';

interface HealthBody {
  status: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

describe('GET /api/health', () => {
  afterEach(() => {
    delete process.env.INFLOOP_API_TOKEN;
  });

  it('returns 200 with the health payload', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.version).toBe(pkg.version);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('is reachable without authentication even when a token is configured', async () => {
    process.env.INFLOOP_API_TOKEN = 'secret-token';
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
