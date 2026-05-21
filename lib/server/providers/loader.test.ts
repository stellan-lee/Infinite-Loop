import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

let tmpDir: string;
let tmpConnDir: string;
let prevDir: string | undefined;
let prevConnDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-providers-'));
  tmpConnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-connections-'));
  prevDir = process.env.INFLOOP_PROVIDERS_DIR;
  prevConnDir = process.env.INFLOOP_CONNECTIONS_DIR;
  process.env.INFLOOP_PROVIDERS_DIR = tmpDir;
  process.env.INFLOOP_CONNECTIONS_DIR = tmpConnDir;
});

afterEach(async () => {
  if (prevDir === undefined) {
    delete process.env.INFLOOP_PROVIDERS_DIR;
  } else {
    process.env.INFLOOP_PROVIDERS_DIR = prevDir;
  }
  if (prevConnDir === undefined) {
    delete process.env.INFLOOP_CONNECTIONS_DIR;
  } else {
    process.env.INFLOOP_CONNECTIONS_DIR = prevConnDir;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(tmpConnDir, { recursive: true, force: true });
  // Drop the loader's cache between tests.
  const { _resetProviderCache } = await import('./loader');
  _resetProviderCache();
});

function writeManifest(name: string, body: object | string): void {
  fs.writeFileSync(
    path.join(tmpDir, name),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

function writeConnection(name: string, body: object | string): void {
  fs.writeFileSync(
    path.join(tmpConnDir, name),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

describe('providers/loader', () => {
  it('returns [] for an empty / missing directory', async () => {
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('loads valid manifests sorted by label', async () => {
    writeManifest('z.json', {
      id: 'z-prov',
      label: 'Zeta',
      description: 'd',
      bin: 'z',
      args: ['{prompt}'],
      outputFormat: 'plain',
    });
    writeManifest('a.json', {
      id: 'a-prov',
      label: 'Alpha',
      description: 'd',
      bin: 'a',
      args: ['{prompt}'],
      outputFormat: 'plain',
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list.map((m) => m.id)).toEqual(['a-prov', 'z-prov']);
  });

  it('skips malformed JSON without throwing', async () => {
    writeManifest('broken.json', '{not valid');
    writeManifest('ok.json', {
      id: 'ok',
      label: 'Ok',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list.map((m) => m.id)).toEqual(['ok']);
  });

  it('skips manifests with missing required fields', async () => {
    writeManifest('incomplete.json', { id: 'x', label: 'X' });
    writeManifest('ok.json', {
      id: 'ok',
      label: 'Ok',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list.map((m) => m.id)).toEqual(['ok']);
  });

  it('skips manifests with unknown outputFormat', async () => {
    writeManifest('weird.json', {
      id: 'w',
      label: 'W',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'made-up',
    });
    const { loadProviders } = await import('./loader');
    expect((await loadProviders()).map((m) => m.id)).toEqual([]);
  });

  it('skips duplicate ids (first wins, warn-not-throw)', async () => {
    writeManifest('a.json', {
      id: 'dup',
      label: 'A',
      description: 'd',
      bin: 'a-bin',
      args: ['{prompt}'],
      outputFormat: 'plain',
    });
    writeManifest('b.json', {
      id: 'dup',
      label: 'B',
      description: 'd',
      bin: 'b-bin',
      args: ['{prompt}'],
      outputFormat: 'plain',
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list).toHaveLength(1);
    // Sorted reads `a.json` before `b.json`; first-wins keeps `bin: 'a-bin'`.
    const winner = list[0];
    if (winner.transport !== 'cli') throw new Error('expected cli transport');
    expect(winner.bin).toBe('a-bin');
  });

  it('loads an http-transport manifest with auth + profiles', async () => {
    writeManifest('hermes.json', {
      id: 'hermes',
      label: 'Hermes',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://hermes.example/v1/',
      endpoint: '/chat/completions',
      profilesEndpoint: '/models',
      auth: { type: 'bearer', envVar: 'INFLOOP_HERMES_TOKEN' },
      profiles: [{ id: 'hermes-3', label: 'Hermes 3' }],
      defaultProfile: 'hermes-3',
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list).toHaveLength(1);
    const m = list[0];
    expect(m.transport).toBe('http');
    if (m.transport !== 'http') throw new Error('unreachable'); // type narrow
    // Trailing slash should be stripped from baseUrl.
    expect(m.baseUrl).toBe('https://hermes.example/v1');
    expect(m.endpoint).toBe('/chat/completions');
    expect(m.auth?.envVar).toBe('INFLOOP_HERMES_TOKEN');
    expect(m.profiles).toEqual([{ id: 'hermes-3', label: 'Hermes 3' }]);
    expect(m.defaultProfile).toBe('hermes-3');
  });

  it('rejects an http manifest whose endpoint omits the leading slash', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x/v1',
      endpoint: 'chat/completions',
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects an http manifest whose profilesEndpoint omits the leading slash', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x/v1',
      endpoint: '/chat/completions',
      profilesEndpoint: 'models',
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects an http manifest missing baseUrl', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      endpoint: '/x',
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects an http manifest with non-bearer auth.type', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x',
      endpoint: '/c',
      auth: { type: 'basic', envVar: 'X' },
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects a manifest with an unknown transport', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'grpc',
      baseUrl: 'https://x',
      endpoint: '/c',
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('expands a *.hermes.local.json with ports into one manifest per port', async () => {
    // New shape: label / host / token / ports[{port, profile}]. The
    // loader emits one card per port, labeled by the discovered profile
    // and pointing at `<host>:<port>/v1`.
    writeConnection('my-hermes.hermes.local.json', {
      label: 'My Hermes',
      host: 'https://my-hermes.example',
      token: 'sk-test-123',
      ports: [
        { port: 8001, profile: 'productmanager' },
        { port: 8002, profile: 'engineer' },
      ],
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list).toHaveLength(2);
    // sorted by label → 'engineer' before 'productmanager'.
    const eng = list.find((m) => m.label === 'engineer');
    const pm = list.find((m) => m.label === 'productmanager');
    if (!eng || !pm) throw new Error('expected both manifests');
    if (eng.transport !== 'http' || pm.transport !== 'http') {
      throw new Error('unreachable');
    }
    expect(eng.id).toBe('my-hermes-engineer');
    expect(eng.baseUrl).toBe('https://my-hermes.example:8002/v1');
    expect(eng.defaultProfile).toBe('engineer');
    expect(eng.auth?.token).toBe('sk-test-123');
    expect(pm.id).toBe('my-hermes-productmanager');
    expect(pm.baseUrl).toBe('https://my-hermes.example:8001/v1');
  });

  it('drops malformed port entries but keeps the rest of the connection', async () => {
    writeConnection('mixed.hermes.local.json', {
      label: 'Mixed',
      host: 'https://h.example',
      token: 't',
      ports: [
        { port: 8001, profile: 'good' },
        { port: 'oops' }, // bad port
        { port: 8003, profile: '' }, // empty profile
        { port: 8004, profile: 'alsogood' },
      ],
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.label).sort()).toEqual(['alsogood', 'good']);
  });

  it('hermes-local-store.validateInputSync strips port and path from host', async () => {
    const { validateInputSync } = await import('./hermes-local-store');
    expect(
      validateInputSync({
        label: 'A',
        host: 'https://h.example',
        token: 't',
        ports: [{ port: 8001, profile: 'm' }],
      }).host,
    ).toBe('https://h.example');
    // User pasted port + path — both stripped.
    expect(
      validateInputSync({
        label: 'A',
        host: 'http://192.168.1.10:9000',
        token: 't',
      }).host,
    ).toBe('http://192.168.1.10');
    // Reject paths that aren't / (more informative than silently stripping).
    expect(() =>
      validateInputSync({
        label: 'A',
        host: 'https://h.example/v1',
        token: 't',
      }),
    ).toThrow(/path/);
  });

  it('hermes-local-store rejects duplicate ports and out-of-range values', async () => {
    const { validateInputSync } = await import('./hermes-local-store');
    expect(() =>
      validateInputSync({
        label: 'A',
        host: 'https://h.example',
        token: 't',
        ports: [{ port: 8001 }, { port: 8001 }],
      }),
    ).toThrow(/listed more than once/);
    expect(() =>
      validateInputSync({
        label: 'A',
        host: 'https://h.example',
        token: 't',
        ports: [{ port: 70000 }],
      }),
    ).toThrow(/1..65535/);
  });

  it('rejects auth that sets neither envVar nor token', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x',
      endpoint: '/c',
      auth: { type: 'bearer' },
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects auth that sets both envVar and token', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x',
      endpoint: '/c',
      auth: { type: 'bearer', envVar: 'X', token: 'y' },
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('resolveBin honors INFLOOP_PROVIDER_BIN_<ID> and INFLOOP_CLAUDE_BIN alias', async () => {
    const { resolveBin } = await import('./loader');
    const claudeManifest = {
      id: 'claude',
      label: 'Claude',
      description: 'd',
      transport: 'cli' as const,
      bin: 'claude',
      args: ['{prompt}'],
      outputFormat: 'plain',
      promptVia: 'arg' as const,
    };
    const otherManifest = {
      ...claudeManifest,
      id: 'codex',
      bin: 'codex',
    };

    expect(resolveBin(claudeManifest)).toBe('claude');

    process.env.INFLOOP_CLAUDE_BIN = '/path/to/legacy';
    expect(resolveBin(claudeManifest)).toBe('/path/to/legacy');
    delete process.env.INFLOOP_CLAUDE_BIN;

    process.env.INFLOOP_PROVIDER_BIN_CLAUDE = '/path/to/new';
    expect(resolveBin(claudeManifest)).toBe('/path/to/new');
    delete process.env.INFLOOP_PROVIDER_BIN_CLAUDE;

    process.env.INFLOOP_PROVIDER_BIN_CODEX = '/path/to/codex';
    expect(resolveBin(otherManifest)).toBe('/path/to/codex');
    delete process.env.INFLOOP_PROVIDER_BIN_CODEX;
  });

  it('loads a cli manifest with envPassthrough and dangerousArgs', async () => {
    writeManifest('ds.json', {
      id: 'ds',
      label: 'DS',
      description: 'd',
      bin: 'x',
      args: ['{dangerousArgs}', '{prompt}'],
      outputFormat: 'plain',
      envPassthrough: ['ANTHROPIC_*', 'OPENAI_API_KEY'],
      dangerousArgs: ['--yolo'],
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list).toHaveLength(1);
    const m = list[0];
    if (m.transport !== 'cli') throw new Error('expected cli transport');
    expect(m.envPassthrough).toEqual(['ANTHROPIC_*', 'OPENAI_API_KEY']);
    expect(m.dangerousArgs).toEqual(['--yolo']);
  });

  it('rejects a cli manifest whose envPassthrough is a bare "*"', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      envPassthrough: ['*'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects a cli manifest whose envPassthrough targets the INFLOOP_ namespace', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      envPassthrough: ['INFLOOP_*'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects a cli manifest whose envPassthrough has a non-trailing wildcard', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      envPassthrough: ['FOO_*_BAR'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects a cli manifest whose dangerousArgs is not a string array', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      dangerousArgs: 'not-an-array',
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects an http manifest that declares envPassthrough', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x',
      endpoint: '/c',
      envPassthrough: ['ANTHROPIC_*'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('loads a cli manifest with a valid egressAllowlist (lowercased)', async () => {
    writeManifest('eg.json', {
      id: 'eg',
      label: 'EG',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      egressAllowlist: ['API.Anthropic.com', '*.anthropic.com', '127.0.0.1'],
    });
    const { loadProviders } = await import('./loader');
    const list = await loadProviders();
    expect(list).toHaveLength(1);
    const m = list[0];
    if (m.transport !== 'cli') throw new Error('expected cli transport');
    expect(m.egressAllowlist).toEqual([
      'api.anthropic.com',
      '*.anthropic.com',
      '127.0.0.1',
    ]);
  });

  it('rejects a cli manifest whose egressAllowlist is a bare "*"', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      egressAllowlist: ['*'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects a cli manifest whose egressAllowlist has a non-leading wildcard', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      bin: 'x',
      args: ['{prompt}'],
      outputFormat: 'plain',
      egressAllowlist: ['api.*.com'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });

  it('rejects a cli manifest whose egressAllowlist entry carries a scheme/port/path', async () => {
    for (const entry of ['https://api.anthropic.com', 'api.anthropic.com:443', 'api.anthropic.com/v1']) {
      writeManifest('bad.json', {
        id: 'bad',
        label: 'Bad',
        description: 'd',
        bin: 'x',
        args: ['{prompt}'],
        outputFormat: 'plain',
        egressAllowlist: [entry],
      });
      const { loadProviders, _resetProviderCache } = await import('./loader');
      _resetProviderCache();
      expect(await loadProviders()).toEqual([]);
    }
  });

  it('rejects an http manifest that declares egressAllowlist', async () => {
    writeManifest('bad.json', {
      id: 'bad',
      label: 'Bad',
      description: 'd',
      transport: 'http',
      baseUrl: 'https://x',
      endpoint: '/c',
      egressAllowlist: ['api.openai.com'],
    });
    const { loadProviders } = await import('./loader');
    expect(await loadProviders()).toEqual([]);
  });
});
