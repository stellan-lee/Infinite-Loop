import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOpenAiConnection,
  getOpenAiConnection,
  updateOpenAiConnection,
} from './openai-local-store';
import { _resetProviderCache, getProvider } from './loader';

let tmpDir: string;
let oldDataDir: string | undefined;
let oldConnectionsDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'infinite-loop-openai-'));
  oldDataDir = process.env.INFLOOP_DATA_DIR;
  oldConnectionsDir = process.env.INFLOOP_CONNECTIONS_DIR;
  process.env.INFLOOP_DATA_DIR = tmpDir;
  process.env.INFLOOP_CONNECTIONS_DIR = join(tmpDir, 'connections');
  _resetProviderCache();
});

afterEach(() => {
  if (oldDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = oldDataDir;
  if (oldConnectionsDir === undefined) delete process.env.INFLOOP_CONNECTIONS_DIR;
  else process.env.INFLOOP_CONNECTIONS_DIR = oldConnectionsDir;
  _resetProviderCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('OpenAI-compatible provider store', () => {
  it('keeps API keys and custom header values write-only while expanding into a reusable HTTP provider', async () => {
    const created = await createOpenAiConnection(null, {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.example/v1/',
      apiKey: 'secret-key',
      headers: [{ name: 'HTTP-Referer', value: 'https://app.example' }],
      defaultProfile: 'model-a',
      profiles: [{ id: 'model-a', label: 'Model A' }],
      requestOptions: { temperature: 0.25 },
    });
    expect(created).toMatchObject({ id: 'openrouter', hasApiKey: true, headerNames: ['HTTP-Referer'] });
    expect(created.endpoint).toBe('/responses');
    expect(JSON.stringify(created)).not.toContain('temperature');
    expect(JSON.stringify(created)).not.toContain('secret-key');
    expect(JSON.stringify(created)).not.toContain('app.example');

    const read = await getOpenAiConnection(created.id);
    expect(read).toEqual(created);
    const provider = await getProvider(created.id);
    expect(provider?.transport).toBe('http');
    if (provider?.transport !== 'http') throw new Error('expected HTTP provider');
    expect(provider.kind).toBe('openai-local');
    expect(provider.baseUrl).toBe('https://openrouter.example/v1');
    expect(provider.auth?.token).toBe('secret-key');
    expect(provider.headers).toEqual({ 'HTTP-Referer': 'https://app.example' });
    expect(provider.requestOptions).toEqual({ temperature: 0.25 });

    const file = join(tmpDir, 'connections', 'openrouter.openai.local.json');
    expect(readFileSync(file, 'utf8')).toContain('secret-key');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves write-only fields on edit when blank and rejects protocol-owned request settings', async () => {
    const created = await createOpenAiConnection(null, {
      label: 'Local', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'key-1',
      headers: [{ name: 'x-key', value: 'value-1' }], requestOptions: { top_p: 0.8, max_tokens: 128, max_completion_tokens: 64 },
    });
    const updated = await updateOpenAiConnection(created.id, {
      label: 'Local Updated', baseUrl: 'http://127.0.0.1:8000/v1',
      headers: [{ name: 'x-key', value: '' }], requestOptions: { top_p: 0.5 },
    });
    expect(updated?.hasApiKey).toBe(true);
    _resetProviderCache();
    const provider = await getProvider(created.id);
    if (provider?.transport !== 'http') throw new Error('expected HTTP provider');
    expect(provider.auth?.token).toBe('key-1');
    expect(provider.headers).toEqual({ 'x-key': 'value-1' });
    expect(provider.requestOptions).toEqual({ top_p: 0.5 });

    const publicAfterUpdate = await getOpenAiConnection(created.id);
    expect(JSON.stringify(publicAfterUpdate)).not.toContain('top_p');

    await updateOpenAiConnection(created.id, {
      label: 'Local Updated', baseUrl: 'http://127.0.0.1:8000/v1', clearApiKey: true,
    });
    _resetProviderCache();
    const cleared = await getProvider(created.id);
    if (cleared?.transport !== 'http') throw new Error('expected HTTP provider');
    expect(cleared.auth).toBeUndefined();

    await expect(createOpenAiConnection(null, {
      label: 'Bad', baseUrl: 'https://example.test/v1', requestOptions: { model: 'not-allowed' },
    })).rejects.toThrow('controlled by the OpenAI node');

    await expect(createOpenAiConnection(null, {
      label: 'Leaky URL', baseUrl: 'https://secret@example.test/v1',
    })).rejects.toThrow('must not include credentials');
    await expect(createOpenAiConnection(null, {
      label: 'Leaky Endpoint', baseUrl: 'https://example.test/v1', endpoint: '/chat?api_key=secret',
    })).rejects.toThrow('must not include query or fragment');
    await expect(createOpenAiConnection(null, {
      label: 'Leaky Option', baseUrl: 'https://example.test/v1', requestOptions: { extra: { api_key: 'secret' } },
    })).rejects.toThrow('may not contain credentials');
    await expect(createOpenAiConnection(null, {
      label: 'Nested Header Secret', baseUrl: 'https://example.test/v1',
      requestOptions: { headers: { 'x-api-key': 'secret' } },
    })).rejects.toThrow('may not contain credentials');
    await expect(createOpenAiConnection(null, {
      label: 'Camel Secret', baseUrl: 'https://example.test/v1',
      requestOptions: { openaiApiKey: 'secret' },
    })).rejects.toThrow('may not contain credentials');

    const limits = await createOpenAiConnection(null, {
      label: 'Limits', baseUrl: 'https://example.test/v1',
      requestOptions: { max_tokens: 128, max_completion_tokens: 64 },
    });
    _resetProviderCache();
    const limitsProvider = await getProvider(limits.id);
    if (limitsProvider?.transport !== 'http') throw new Error('expected HTTP provider');
    expect(limitsProvider.requestOptions).toEqual({ max_tokens: 128, max_completion_tokens: 64 });
  });

  it('migrates a supplied legacy Chat Completions endpoint to Responses', async () => {
    const created = await createOpenAiConnection(null, {
      label: 'Legacy Local',
      baseUrl: 'https://example.test/v1',
      endpoint: '/chat/completions',
    });
    expect(created.endpoint).toBe('/responses');
    _resetProviderCache();
    const provider = await getProvider(created.id);
    if (provider?.transport !== 'http') throw new Error('expected HTTP provider');
    expect(provider.endpoint).toBe('/responses');
  });

  it('rejects non-Responses endpoints for UI-managed providers', async () => {
    await expect(createOpenAiConnection(null, {
      label: 'Wrong Endpoint', baseUrl: 'https://example.test/v1', endpoint: '/v1/generate',
    })).rejects.toThrow('must be "/responses"');
  });
});
