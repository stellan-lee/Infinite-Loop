import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { runHttpProvider, runHttpStructuredOutput } from './http-runner';
import type { HttpProviderManifest } from './types';

/* ── tiny in-process SSE stub server ─────────────────────────────
 * Uses node:http directly (not Bun.serve) because happy-dom is preloaded in
 * tests and overwrites the global `Response`, which breaks Bun.serve. node:http
 * deals in raw sockets, so we can write SSE bytes manually and stay
 * independent of the DOM polyfill.
 */
type ChatHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Stub {
  url: string;
  stop: () => Promise<void>;
  lastChatRequest: () => { headers: Record<string, string>; body: unknown } | null;
}

function startStub(chatHandler: ChatHandler): Promise<Stub> {
  return new Promise((resolve, reject) => {
    let captured: { headers: Record<string, string>; body: unknown } | null = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let buf = '';
        req.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
        });
        req.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(buf);
          } catch {
            // ignore — tests can still assert on the raw body via captured later
          }
          captured = { headers, body: parsed };
          chatHandler(req, res, buf);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
        lastChatRequest: () => captured,
      });
    });
  });
}

function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // happy-dom (preloaded for component tests) enforces CORS even on
    // Node-side fetch calls. In production the runner runs on the Next.js
    // server where there's no CORS check — these headers exist just so the
    // happy-dom polyfill doesn't block our test requests.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
  });
}

function makeManifest(baseUrl: string, opts: Partial<HttpProviderManifest> = {}): HttpProviderManifest {
  return {
    id: 'hermes-test',
    label: 'Hermes Test',
    description: 'd',
    transport: 'http',
    baseUrl,
    endpoint: '/v1/chat/completions',
    auth: { type: 'bearer', envVar: 'TEST_HERMES_TOKEN' },
    defaultProfile: 'hermes-test-model',
    ...opts,
  };
}

let stub: Stub | null = null;
let savedFetch: typeof fetch | null = null;

beforeEach(() => {
  process.env.TEST_HERMES_TOKEN = 'test-token-123';
  // happy-dom (preloaded for component tests) replaces global fetch with a
  // CORS-enforcing shim that blocks 127.0.0.1 calls. Swap in the native fetch
  // for these tests — production runs on the Next.js server with no CORS.
  const native = (globalThis as { __infloopNativeFetch?: typeof fetch })
    .__infloopNativeFetch;
  if (native) {
    savedFetch = globalThis.fetch;
    globalThis.fetch = native;
  }
});

afterEach(async () => {
  delete process.env.TEST_HERMES_TOKEN;
  if (savedFetch) {
    globalThis.fetch = savedFetch;
    savedFetch = null;
  }
  if (stub) {
    await stub.stop();
    stub = null;
  }
});

describe('runHttpProvider', () => {
  it('streams OpenAI-style deltas and resolves with exitCode 0', async () => {
    stub = await startStub((_req, res) => {
      writeSseHeaders(res);
      res.write(sseFrame({ choices: [{ delta: { content: 'Hi ' } }] }));
      res.write(sseFrame({ choices: [{ delta: { content: 'there' } }] }));
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const chunks: string[] = [];
    const result = await runHttpProvider(makeManifest(stub.url), {
      prompt: 'hello',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onStdoutChunk: (c) => chunks.push(c),
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('Hi there');
    expect(chunks).toEqual(['Hi ', 'there']);
    const captured = stub.lastChatRequest();
    expect(captured?.headers.authorization).toBe('Bearer test-token-123');
    const body = captured?.body as { model?: string; messages?: unknown };
    expect(body?.model).toBe('hermes-test-model');
    expect(body?.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('uses opts.profile to override defaultProfile in the request body', async () => {
    stub = await startStub((_req, res) => {
      writeSseHeaders(res);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const result = await runHttpProvider(makeManifest(stub.url), {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
      profile: 'picked-by-user',
    });

    expect(result.exitCode).toBe(0);
    const body = stub.lastChatRequest()?.body as { model?: string };
    expect(body?.model).toBe('picked-by-user');
  });

  it('errors when no profile is set and no defaultProfile is configured', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const manifest = makeManifest(stub.url, { defaultProfile: undefined });
    const result = await runHttpProvider(manifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no profile selected');
    expect(stub.lastChatRequest()).toBeNull();
  });

  it('errors when the auth env var is not set', async () => {
    delete process.env.TEST_HERMES_TOKEN;
    stub = await startStub((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const result = await runHttpProvider(makeManifest(stub.url), {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('TEST_HERMES_TOKEN');
    expect(stub.lastChatRequest()).toBeNull();
  });

  it('captures HTTP error responses with the response body in stderr', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(400, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      res.end('{"error":"bad model"}');
    });
    const result = await runHttpProvider(makeManifest(stub.url), {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HTTP 400');
    expect(result.stderr).toContain('bad model');
  });

  it('marks timedOut when the stream stays open past timeoutMs', async () => {
    stub = await startStub((_req, res) => {
      writeSseHeaders(res);
      res.write(sseFrame({ choices: [{ delta: { content: 'a' } }] }));
      // Keep the connection open — never call res.end().
    });

    const start = Date.now();
    const result = await runHttpProvider(makeManifest(stub.url), {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 150,
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(2000);
    // The partial delta should still have been captured before the timeout.
    expect(result.stdout).toBe('a');
  });

  it('aborts cleanly when the external AbortSignal fires', async () => {
    stub = await startStub((_req, res) => {
      writeSseHeaders(res);
      // SSE keep-alive comment forces Node to flush the response headers
      // (writeHead alone doesn't send them over the wire until the first
      // body byte). Without this, fetch never resolves and abort has nothing
      // to interrupt — masking real abort-propagation bugs.
      res.write(': keepalive\n\n');
      // Hold the connection open so abort has time to fire mid-read.
    });

    const ctrl = new AbortController();
    const promise = runHttpProvider(makeManifest(stub.url), {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 50);
    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});

describe('runHttpStructuredOutput', () => {
  it('sends one strict JSON Schema request and returns assistant content', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"answer":42}' } }] }));
    });

    const result = await runHttpStructuredOutput(
      makeManifest(stub.url),
      {
        prompt: 'answer the question',
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: new AbortController().signal,
        profile: 'selected-model',
      },
      { type: 'object', properties: { answer: { type: 'number' } }, additionalProperties: false },
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: '{"answer":42}', timedOut: false });
    const body = stub.lastChatRequest()?.body as {
      model?: string;
      stream?: boolean;
      response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: unknown } };
    };
    expect(body.model).toBe('selected-model');
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        strict: true,
        schema: { type: 'object', properties: { answer: { type: 'number' } }, additionalProperties: false },
      },
    });
    expect(stub.lastChatRequest()?.headers.authorization).toBe('Bearer test-token-123');
  });

  it('returns a bounded failure when the provider refuses the request', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ choices: [{ message: { refusal: 'cannot answer' } }] }));
    });

    const result = await runHttpStructuredOutput(
      makeManifest(stub.url),
      { prompt: 'p', cwd: process.cwd(), timeoutMs: 5000, signal: new AbortController().signal },
      { type: 'object' },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('provider refusal: cannot answer');
  });

  it('returns bounded errors for HTTP failures, malformed bodies, and empty completions', async () => {
    const cases = [
      {
        name: 'HTTP failure',
        respond: (res: ServerResponse) => {
          res.writeHead(422, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end('schema unsupported');
        },
        error: /HTTP 422: schema unsupported/,
      },
      {
        name: 'malformed body',
        respond: (res: ServerResponse) => {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end('not json');
        },
        error: /invalid JSON response/,
      },
      {
        name: 'empty completion',
        respond: (res: ServerResponse) => {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
        },
        error: /did not contain assistant content/,
      },
    ];

    for (const testCase of cases) {
      stub = await startStub((_req, res) => testCase.respond(res));
      const result = await runHttpStructuredOutput(
        makeManifest(stub.url),
        { prompt: 'p', cwd: process.cwd(), timeoutMs: 5000, signal: new AbortController().signal },
        { type: 'object' },
      );
      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toMatch(testCase.error);
      await stub.stop();
      stub = null;
    }
  });

  it('times out while waiting for a non-streaming response body', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.flushHeaders();
      res.write(' ');
    });
    const result = await runHttpStructuredOutput(
      makeManifest(stub.url),
      { prompt: 'p', cwd: process.cwd(), timeoutMs: 100, signal: new AbortController().signal },
      { type: 'object' },
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true, stdout: '' });
  });

  it('honours caller abort while waiting for a non-streaming response body', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.flushHeaders();
      res.write(' ');
    });
    const controller = new AbortController();
    const pending = runHttpStructuredOutput(
      makeManifest(stub.url),
      { prompt: 'p', cwd: process.cwd(), timeoutMs: 5000, signal: controller.signal },
      { type: 'object' },
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toMatchObject({ exitCode: null, timedOut: false, stdout: '' });
  });

  it('honours timeout and caller abort while an HTTP error body remains open', async () => {
    for (const testCase of [
      { name: 'timeout', timeoutMs: 100, abort: false, timedOut: true },
      { name: 'caller abort', timeoutMs: 5000, abort: true, timedOut: false },
    ]) {
      stub = await startStub((_req, res) => {
        res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.flushHeaders();
        res.write('{');
      });
      const controller = new AbortController();
      const pending = runHttpStructuredOutput(
        makeManifest(stub.url),
        { prompt: 'p', cwd: process.cwd(), timeoutMs: testCase.timeoutMs, signal: controller.signal },
        { type: 'object' },
      );
      if (testCase.abort) setTimeout(() => controller.abort(), 50);
      const result = await pending;
      expect(result.exitCode, testCase.name).toBeNull();
      expect(result.timedOut, testCase.name).toBe(testCase.timedOut);
      await stub.stop();
      stub = null;
    }
  });
});
