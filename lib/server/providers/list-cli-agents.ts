import { spawn } from 'node:child_process';
import { registerChild, unregisterChild } from '../child-registry';
import { resolveBin } from './loader';
import type { CliProviderManifest } from './types';

/**
 * One entry from a CLI provider's agent listing.
 *
 * `group` distinguishes user-defined agents from built-in ones so the UI
 * can render them in two clumps with the user's own listed first.
 */
export interface CliAgent {
  name: string;
  model?: string;
  group: 'user' | 'project' | 'builtin';
}

/**
 * Parse the output of `claude agents` into a structured list. Pure; exported
 * for tests.
 *
 * Expected shape (whitespace and counts may vary across versions):
 *
 *   6 active agents
 *
 *   User agents:
 *     code-review-agent · opus
 *     senior-review-agent · opus · user memory
 *
 *   Built-in agents:
 *     Explore · haiku
 *     general-purpose · inherit
 *
 * We track the current section by the heading and treat each indented
 * `name · meta1 · meta2` line as one agent. Unknown sections are ignored.
 */
export function parseClaudeAgents(output: string): CliAgent[] {
  const out: CliAgent[] = [];
  let group: 'user' | 'project' | 'builtin' | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;
    const headingMatch = /^([A-Za-z][\w -]*):\s*$/.exec(line);
    if (headingMatch) {
      const h = headingMatch[1].toLowerCase();
      if (h.startsWith('user')) group = 'user';
      else if (h.startsWith('project') || h.startsWith('local')) group = 'project';
      else if (h.startsWith('built')) group = 'builtin';
      else group = null;
      continue;
    }
    // Indented entry. Falls back to a sane group when claude's output omits
    // the heading (older versions).
    if (!/^\s+\S/.test(rawLine)) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\s+·\s+/);
    const name = parts[0]?.trim();
    if (!name) continue;
    const model = parts[1]?.trim();
    out.push({
      name,
      model: model && model.length > 0 ? model : undefined,
      group: group ?? 'builtin',
    });
  }
  return out;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Spawn `<bin> agents` for a CLI provider, capture stdout, and parse it.
 *
 * Runs in `opts.cwd` when provided so that user/project/local `claude`
 * settings are picked up — `claude agents` resolves agents from the working
 * directory's settings stack, not the server's. Without this a project-scoped
 * agent (defined in `<workflow-cwd>/.claude/agents/…`) would silently not
 * appear in the dropdown.
 *
 * Resolves with the parsed list on exit 0; otherwise rejects with an Error.
 * The error message is not surfaced to the client unfiltered (see the route).
 */
export async function listCliAgents(
  manifest: CliProviderManifest,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<CliAgent[]> {
  const bin = resolveBin(manifest);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<CliAgent[]>((resolve, reject) => {
    const child = spawn(bin, ['agents'], {
      cwd: opts.cwd && opts.cwd.length > 0 ? opts.cwd : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid != null) registerChild(child.pid, { bin });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      if (child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      }
    }, timeoutMs);
    const finish = (err: Error | null, agents?: CliAgent[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid != null) unregisterChild(child.pid);
      if (err) reject(err);
      else resolve(agents!);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      finish(new Error(`spawn ${bin} agents: ${err.message}`));
    });
    child.on('close', (code) => {
      if (killed) {
        finish(new Error(`${bin} agents timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim() || stdout.trim() || `exit ${code}`;
        finish(new Error(`${bin} agents failed: ${tail}`));
        return;
      }
      finish(null, parseClaudeAgents(stdout));
    });
  });
}
