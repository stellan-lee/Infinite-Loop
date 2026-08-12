import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetProviderCache } from '@/lib/server/providers/loader';
import { GET, POST } from './route';

let tmpDir: string;
let previousDataDir: string | undefined;
let previousConnectionsDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'infloop-openai-route-'));
  previousDataDir = process.env.INFLOOP_DATA_DIR;
  previousConnectionsDir = process.env.INFLOOP_CONNECTIONS_DIR;
  process.env.INFLOOP_DATA_DIR = tmpDir;
  process.env.INFLOOP_CONNECTIONS_DIR = join(tmpDir, 'connections');
  _resetProviderCache();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = previousDataDir;
  if (previousConnectionsDir === undefined) delete process.env.INFLOOP_CONNECTIONS_DIR;
  else process.env.INFLOOP_CONNECTIONS_DIR = previousConnectionsDir;
  _resetProviderCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('OpenAI provider API', () => {
  it('creates a provider but redacts API keys and header values from POST and list responses', async () => {
    const post = await POST(new Request('http://localhost/api/providers/openai-local', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Private Gateway', baseUrl: 'https://gateway.example/v1', apiKey: 'sk-do-not-return',
        headers: [{ name: 'x-gateway-key', value: 'header-do-not-return' }],
        requestOptions: { reasoning: { effort: 'high' } },
      }),
    }));
    expect(post.status).toBe(201);
    const created = await post.text();
    expect(created).not.toContain('sk-do-not-return');
    expect(created).not.toContain('header-do-not-return');
    expect(created).not.toContain('reasoning');
    expect(created).toContain('hasApiKey');
    expect(created).toContain('x-gateway-key');

    const list = await GET(new Request('http://localhost/api/providers/openai-local'));
    expect(list.status).toBe(200);
    const listed = await list.text();
    expect(listed).not.toContain('sk-do-not-return');
    expect(listed).not.toContain('header-do-not-return');
  });
});
