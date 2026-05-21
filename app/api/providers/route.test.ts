import { afterAll, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import type { ProviderManifest } from '@/lib/server/providers/types';

const realLoader = { ...(await import('@/lib/server/providers/loader')) };

mock.module('@/lib/server/providers/loader', () => ({
  ...realLoader,
  loadProviders: mock(),
}));

import * as loader from '@/lib/server/providers/loader';
import { GET } from './route';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
const mocked = loader as unknown as { loadProviders: AnyMock };

afterAll(() => {
  mock.module('@/lib/server/providers/loader', () => realLoader);
});

beforeEach(() => {
  mocked.loadProviders.mockReset();
});

describe('GET /api/providers', () => {
  it('includes availability for CLI providers', async () => {
    const providers: ProviderManifest[] = [
      {
        id: 'missing-cli',
        label: 'Missing CLI',
        description: 'missing binary',
        transport: 'cli',
        bin: '__definitely_missing_infloop_cli__',
        args: ['{prompt}'],
        outputFormat: 'plain',
        promptVia: 'arg',
      },
      {
        id: 'http-provider',
        label: 'HTTP Provider',
        description: 'remote provider',
        transport: 'http',
        baseUrl: 'https://example.test/v1',
        endpoint: '/chat/completions',
      },
    ];
    mocked.loadProviders.mockResolvedValueOnce(providers);

    const res = await GET(new Request('http://localhost/api/providers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toEqual([
      expect.objectContaining({
        id: 'missing-cli',
        transport: 'cli',
        available: false,
        health: expect.objectContaining({ status: 'missing' }),
      }),
      expect.objectContaining({
        id: 'http-provider',
        transport: 'http',
        available: true,
        health: expect.objectContaining({ status: 'unknown' }),
      }),
    ]);
  });
});
