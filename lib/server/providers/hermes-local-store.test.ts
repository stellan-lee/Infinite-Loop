import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConnection,
  getConnection,
  type HermesLocalInput,
} from './hermes-local-store';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

/** Stash an env var, then set or delete it. `afterEach` restores every stash. */
function stash(name: string, value?: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'infinite-loop-hermes-'));
  stash('INFLOOP_DATA_DIR', tmpDir);
  stash('INFLOOP_CONNECTIONS_DIR', join(tmpDir, 'connections'));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// Pre-supplied profiles let `validateInput` skip network discovery, so the
// store can be exercised entirely offline.
const input: HermesLocalInput = {
  label: 'My Box',
  host: 'https://example.com',
  token: 'tok-secret',
  ports: [{ port: 8001, profile: 'model-a' }],
};

describe('writeConnection (atomic, via createConnection)', () => {
  it('round-trips a connection written through the temp-file + rename path', async () => {
    const created = await createConnection(null, input);
    const read = await getConnection(created.id);
    expect(read).not.toBeNull();
    expect(read?.host).toBe('https://example.com');
    expect(read?.token).toBe('tok-secret');
    expect(read?.ports).toEqual([{ port: 8001, profile: 'model-a' }]);
  });

  it('leaves no .tmp file behind once the write commits', async () => {
    await createConnection(null, input);
    const dir = join(tmpDir, 'connections');
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files.some((f) => f.endsWith('.hermes.local.json'))).toBe(true);
  });

  it('writes the connection file 0600 — it carries a bearer token', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const created = await createConnection(null, input);
    const dir = join(tmpDir, 'connections');
    const connFile = readdirSync(dir).find((f) =>
      f.endsWith('.hermes.local.json'),
    );
    expect(connFile).toBeDefined();
    const mode = statSync(join(dir, connFile as string)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(created.id.length).toBeGreaterThan(0);
  });
});
