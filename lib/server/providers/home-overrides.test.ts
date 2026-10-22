import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runProvider, validateHomeOverrides } from './runner';
import type { CliProviderManifest, HttpProviderManifest } from './types';
import { buildChildEnv } from '../child-env';

const fixture = path.resolve('tests/fixtures/home-worker.cjs');
const manifest: CliProviderManifest = {
  id: 'home-fixture', label: 'Fixture', description: 'Fixture', transport: 'cli',
  bin: process.execPath, args: [fixture, '{prompt}'], outputFormat: 'plain', promptVia: 'arg',
  // Node needs the script before argv; the fixture records these capability args.
  homeOverrideArgs: [fixture, '-c', 'allow_login_shell=false'], envPassthrough: ['CODEX_HOME'],
};
// Use node -e so capability arguments are ordinary application argv.
const script = await fs.readFile(fixture, 'utf8');
const capable = { ...manifest, args: ['{prompt}'], homeOverrideArgs: ['-e', script, '--', '-c', 'allow_login_shell=false'] };
const dirs: string[] = [];
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'home-overrides-')); dirs.push(dir); return dir; }
function options(cwd: string, extra: object = {}) {
  return { cwd, prompt: 'hello', timeoutMs: 5000, signal: new AbortController().signal, ...extra };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('worker home overrides', () => {
  for (const settings of [{}, { home: 'user home' }, { codexHome: 'codex home' }, { home: 'user home', codexHome: 'codex home' }]) {
    it(`preserves independent child paths: ${JSON.stringify(settings)}`, async () => {
      const cwd = await root();
      const baseline = buildChildEnv({ passthrough: ['CODEX_HOME'] });
      const chunks: string[] = [];
      const result = await runProvider(Object.keys(settings).length ? capable : manifest, options(cwd, { ...settings, onStdoutChunk: (s: string) => chunks.push(s) }));
      expect(result.exitCode).toBe(0);
      const child = JSON.parse(result.stdout);
      expect(child.home).toBe('home' in settings ? path.join(cwd, settings.home!) : baseline.HOME ?? null);
      expect(child.codexHome).toBe('codexHome' in settings ? path.join(cwd, settings.codexHome!) : baseline.CODEX_HOME ?? null);
      expect(child.secretPresent).toBe(false);
      if (Object.keys(settings).length) {
        expect(child.args).toContain('allow_login_shell=false');
        expect(chunks[0]).toContain('[homes]');
        expect(result.stdout).not.toContain('[homes]');
        expect(child.homeExists).toBe(true);
        if ('codexHome' in settings) expect(child.codexHomeExists).toBe(true);
      } else {
        expect(child.args).toEqual(['hello']);
        expect(chunks.join('')).toBe(result.stdout);
      }
      expect(process.env.HOME).toBe(baseline.HOME);
      expect(process.env.CODEX_HOME).toBe(baseline.CODEX_HOME);
    });
  }

  it('treats blank settings as absent and keeps original argv', async () => {
    const result = await runProvider(manifest, options(await root(), { home: ' \n', codexHome: ' ' }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).args).toEqual(['hello']);
  });

  it('supports literal absolute paths, escaped diagnostics, and repeated launches', async () => {
    const cwd = await root();
    const home = path.join(cwd, 'line\nbreak " $HOME ~ {{literal}}');
    for (let i = 0; i < 2; i++) {
      const chunks: string[] = [];
      const result = await runProvider(capable, options(cwd, { home, onStdoutChunk: (s: string) => chunks.push(s) }));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).home).toBe(home);
      expect(chunks[0]).toContain(JSON.stringify(home));
      expect(chunks[0].split('\n')).toHaveLength(2);
      if (process.env.CODEX_HOME === undefined) expect(chunks[0]).toContain('unset (default: HOME/.codex)');
    }
  });

  it('resolves simultaneous workers independently without mutating parent roots', async () => {
    const parent = { home: process.env.HOME, codexHome: process.env.CODEX_HOME };
    const roots = await Promise.all([root(), root()]);
    const results = await Promise.all(roots.map((cwd) => runProvider(capable, options(cwd, { home: 'home', codexHome: 'codex' }))));
    results.forEach((result, i) => {
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ home: path.join(roots[i], 'home'), codexHome: path.join(roots[i], 'codex') });
    });
    expect({ home: process.env.HOME, codexHome: process.env.CODEX_HOME }).toEqual(parent);
  });

  it('returns a setting-specific directory error before launch', async () => {
    const cwd = await root();
    await fs.writeFile(path.join(cwd, 'collision'), 'file');
    const result = await runProvider(capable, options(cwd, { codexHome: 'collision/child' }));
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('codexHome: cannot create directory');
    expect(result.stdout).toBe('');
  });

  it('rejects unsupported CLI/HTTP and malformed values before filesystem or network setup', async () => {
    const cwd = await root();
    const http: HttpProviderManifest = { id: 'http', label: 'HTTP', description: '', transport: 'http', baseUrl: 'http://127.0.0.1:1', endpoint: '/responses' };
    for (const provider of [{ ...manifest, homeOverrideArgs: undefined }, http]) {
      const result = await runProvider(provider, options(cwd, { home: 'must-not-exist' }));
      expect(result.stderr).toContain('does not support');
      expect(await fs.readdir(cwd)).toEqual([]);
    }
    for (const value of [null, 12, {}, 'bad\0path']) {
      const result = await runProvider(capable, options(cwd, { home: value }));
      expect(result.stderr).toContain('home must be a string without NUL');
    }
    expect(() => validateHomeOverrides({ ...manifest, homeOverrideArgs: [] }, { home: 'x' })).toThrow('does not support');
  });

  it('does not create roots or launch a cancelled worker', async () => {
    const cwd = await root();
    const controller = new AbortController(); controller.abort();
    const result = await runProvider(capable, options(cwd, { home: 'cancelled', signal: controller.signal }));
    expect(result.stderr).toContain('cancelled');
    expect(await fs.readdir(cwd)).toEqual([]);
  });
});


it('preserves inherited CODEX_HOME in a separate runner process when only HOME is configured', async () => {
  const cwd = await root();
  const inherited = path.join(cwd, 'inherited codex');
  await fs.mkdir(inherited);
  const runnerUrl = new URL('./runner.ts', import.meta.url).href;
  const program = `const { runProvider } = await import(${JSON.stringify(runnerUrl)}); const result = await runProvider(${JSON.stringify(capable)}, { cwd: ${JSON.stringify(cwd)}, home: 'new home', prompt: 'p', timeoutMs: 5000, signal: new AbortController().signal }); process.stdout.write(JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ['--eval', program], { env: { ...buildChildEnv(), CODEX_HOME: inherited }, encoding: 'utf8' });
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ home: path.join(cwd, 'new home'), codexHome: inherited });
});

it('merges home roots with enforced proxy controls and keeps diagnostics separate', async () => {
  const previous = process.env.INFLOOP_EGRESS_ENFORCE;
  process.env.INFLOOP_EGRESS_ENFORCE = '1';
  try {
    const result = await runProvider({ ...capable, egressAllowlist: [] }, options(await root(), { home: 'home' }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.parse(result.stdout).secretPresent).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.INFLOOP_EGRESS_ENFORCE;
    else process.env.INFLOOP_EGRESS_ENFORCE = previous;
  }
});

it('checks cancellation after asynchronous directory setup before spawning', async () => {
  const controller = new AbortController();
  const result = await runProvider(capable, options(await root(), { home: 'home', signal: controller.signal, onStdoutChunk: () => controller.abort() }));
  expect(result.exitCode).toBeNull();
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('cancelled');
});


it('applies the same roots and leading arguments for stdin prompt delivery', async () => {
  const cwd = await root();
  const result = await runProvider({ ...capable, args: [], promptVia: 'stdin' }, options(cwd, { home: 'stdin home', codexHome: 'stdin codex' }));
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ home: path.join(cwd, 'stdin home'), codexHome: path.join(cwd, 'stdin codex') });
  expect(JSON.parse(result.stdout).args).toContain('allow_login_shell=false');
});
