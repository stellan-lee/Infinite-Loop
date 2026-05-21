import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';

/**
 * GET /api/fs/list?path=/some/absolute/path
 *
 * Returns the immediate subdirectories of `path` so the workflow editor's
 * folder picker can navigate the *server's* filesystem. Browsers can't hand
 * back an absolute path from their native folder picker (security sandbox),
 * so the server has to do the listing.
 *
 * Hidden directories (dotfiles) are excluded by default; pass
 * `?showHidden=1` to include them. Files are never returned.
 *
 * SECURITY: this route exposes the server's filesystem tree, so it is gated
 * by `requireAuth` like every other data route. When `INFLOOP_API_TOKEN` is
 * unset the server is in open mode and the same trust assumption applies as
 * to `/api/run` and the LAN-wide bind in server.ts — deploy on a trusted
 * network only.
 */
export async function GET(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const requested = url.searchParams.get('path');
  const showHidden = url.searchParams.get('showHidden') === '1';

  // Empty/missing path defaults to the user's home directory — sensible
  // starting point for a "pick where to run the agent" picker.
  const initial = requested && requested.trim() ? requested : homedir();
  if (!isAbsolute(initial)) {
    return NextResponse.json(
      { error: 'path must be absolute' },
      { status: 400 },
    );
  }

  // resolve() collapses any `..` segments so a malicious caller can't trick
  // us into reporting a path we never actually read from.
  const path = resolve(initial);

  let entries: Array<{ name: string; isDir: true }>;
  try {
    const items = await readdir(path, { withFileTypes: true });
    entries = items
      .filter((e) => e.isDirectory())
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, isDir: true as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to read';
    return NextResponse.json({ error: message, path }, { status: 400 });
  }

  const parent = dirname(path);
  return NextResponse.json({
    path,
    // Filesystem root has dirname(/) === / on POSIX; signal "no parent" with null.
    parent: parent === path ? null : parent,
    entries,
  });
}
