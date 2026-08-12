import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { structuredOutputExecutor } from './structured-output';
import { _resetProviderCache } from '../providers/loader';
import type { NodeExecutorContext } from '../../shared/workflow';

let providersDir: string;
let previousProvidersDir: string | undefined;
let server: http.Server | null = null;
let calls = 0;
let savedFetch: typeof fetch | null = null;

function context(config: unknown): NodeExecutorContext {
  return {
    config,
    scope: {},
    defaultCwd: process.cwd(),
    signal: new AbortController().signal,
  };
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    calls += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function writeProvider(baseUrl: string, transport: 'http' | 'cli' = 'http') {
  const manifest = transport === 'http'
    ? {
        id: 'test-http', label: 'Test HTTP', description: 'test', transport,
        baseUrl: `${baseUrl}/v1`, endpoint: '/responses', defaultProfile: 'test-model',
      }
    : {
        id: 'test-cli', label: 'Test CLI', description: 'test', transport,
        bin: 'true', args: [], outputFormat: 'plain', promptVia: 'arg',
      };
  fs.writeFileSync(path.join(providersDir, `${manifest.id}.json`), JSON.stringify(manifest));
  _resetProviderCache();
}

beforeEach(() => {
  providersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infloop-structured-node-'));
  previousProvidersDir = process.env.INFLOOP_PROVIDERS_DIR;
  process.env.INFLOOP_PROVIDERS_DIR = providersDir;
  calls = 0;
  const native = (globalThis as { __infloopNativeFetch?: typeof fetch }).__infloopNativeFetch;
  if (native) {
    savedFetch = globalThis.fetch;
    globalThis.fetch = native;
  }
});

afterEach(async () => {
  if (previousProvidersDir === undefined) delete process.env.INFLOOP_PROVIDERS_DIR;
  else process.env.INFLOOP_PROVIDERS_DIR = previousProvidersDir;
  _resetProviderCache();
  if (savedFetch) {
    globalThis.fetch = savedFetch;
    savedFetch = null;
  }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await fsp.rm(providersDir, { recursive: true, force: true });
});

describe('structuredOutputExecutor', () => {
  it('rejects invalid local config before making a request', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '{}' }] }] }));
    });
    writeProvider(baseUrl);

    const out = await structuredOutputExecutor.execute(context({
      providerId: 'test-http', prompt: 'p', schema: [], timeoutMs: 5000,
    }));

    expect(out).toMatchObject({ branch: 'error', outputs: { errorMessage: 'invalid structured-output config' } });
    expect(calls).toBe(0);
  });

  it('stores the parsed JSON value and makes exactly one request', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '{"ready":true}' }] }] }));
    });
    writeProvider(baseUrl);

    const out = await structuredOutputExecutor.execute(context({
      providerId: 'test-http', prompt: 'return readiness', schema: { type: 'object' }, timeoutMs: 5000,
    }));

    expect(out).toMatchObject({ branch: 'next', outputs: { result: { ready: true } } });
    expect(calls).toBe(1);
  });

  it('routes malformed JSON to error without retrying', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'not-json' }] }] }));
    });
    writeProvider(baseUrl);

    const out = await structuredOutputExecutor.execute(context({
      providerId: 'test-http', prompt: 'p', schema: { type: 'object' }, timeoutMs: 5000,
    }));

    expect(out.branch).toBe('error');
    expect(out.outputs).toMatchObject({ errorMessage: expect.stringMatching(/not valid JSON/) });
    expect(calls).toBe(1);
  });

  it('routes an HTTP provider error to error without retrying', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end('unsupported schema');
    });
    writeProvider(baseUrl);

    const out = await structuredOutputExecutor.execute(context({
      providerId: 'test-http', prompt: 'p', schema: { type: 'object' }, timeoutMs: 5000,
    }));

    expect(out).toMatchObject({ branch: 'error', outputs: { errorMessage: expect.stringMatching(/HTTP 422/) } });
    expect(calls).toBe(1);
  });

  it('rejects non-HTTP providers before making a request', async () => {
    writeProvider('http://127.0.0.1:1', 'cli');
    const out = await structuredOutputExecutor.execute(context({
      providerId: 'test-cli', prompt: 'p', schema: { type: 'object' }, timeoutMs: 5000,
    }));
    expect(out).toMatchObject({ branch: 'error', outputs: { errorMessage: expect.stringMatching(/HTTP provider/) } });
    expect(calls).toBe(0);
  });
});
