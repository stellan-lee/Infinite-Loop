import { describe, expect, it } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Guards the fix for the production boot crash-loop. Next.js 16's App Router
 * internals fall back to a throwing AsyncLocalStorage stub unless
 * globalThis.AsyncLocalStorage is set before Next initializes — and Bun begins
 * evaluating Next's module graph before server.ts's own first import, so the
 * module must be a Bun `--preload`, not an in-file import. The first test
 * checks the module's contract; the second checks that every command which
 * launches server.ts still preloads it (dropping the flag from any of them
 * silently reintroduces the crash-loop).
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const MODULE_PATH = 'lib/server/async-local-storage-global';

/**
 * A launch command neutralizes the boot crash only if it `--preload`s this
 * module AND names it before `server.ts` — a preload after the entry is too
 * late.
 */
function preloadsModuleBeforeServer(command: string): boolean {
  const preloadAt = command.indexOf('--preload');
  const moduleAt = command.indexOf(MODULE_PATH);
  const serverAt = command.indexOf('server.ts');
  return (
    preloadAt !== -1 &&
    moduleAt !== -1 &&
    serverAt !== -1 &&
    preloadAt < serverAt &&
    moduleAt < serverAt
  );
}

/*
 * Every file that launches `server.ts`, with a pattern capturing the launch
 * command/args. This list is maintained by hand: a new launch site added
 * elsewhere is NOT auto-discovered — add it here when one appears.
 */
const LAUNCH_SITES: { name: string; file: string; pattern: RegExp }[] = [
  { name: 'Dockerfile CMD', file: 'Dockerfile', pattern: /^CMD\s+(.+)$/m },
  {
    name: 'playwright.config.ts webServer.command',
    file: 'playwright.config.ts',
    pattern: /command:\s*'([^']*)'/,
  },
  {
    name: 'tests/e2e/lib/server.ts spawnServer',
    file: 'tests/e2e/lib/server.ts',
    pattern: /spawn\(\s*'bun'\s*,\s*\[([^\]]*)\]/,
  },
];

describe('async-local-storage-global', () => {
  it('exposes a working AsyncLocalStorage on globalThis', async () => {
    await import('./async-local-storage-global');

    const globalAls = (
      globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }
    ).AsyncLocalStorage;
    expect(globalAls).toBeDefined();

    // Present is not enough — Next calls run()/getStore() on it.
    const store = new globalAls!<string>();
    const seen = store.run('value', () => store.getStore());
    expect(seen).toBe('value');
  });

  it('is preloaded ahead of server.ts by every launch command', () => {
    const failures: string[] = [];

    for (const site of LAUNCH_SITES) {
      const content = readFileSync(join(REPO_ROOT, site.file), 'utf8');
      const launch = content.match(site.pattern)?.[1];
      if (!launch || !preloadsModuleBeforeServer(launch)) {
        failures.push(site.name);
      }
    }

    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const script of ['dev', 'start'] as const) {
      if (!preloadsModuleBeforeServer(pkg.scripts[script] ?? '')) {
        failures.push(`package.json ${script}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
