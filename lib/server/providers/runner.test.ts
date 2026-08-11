import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliArgs, resolveEgressEnforcement, runProvider } from './runner';
import type { CliProviderManifest, ProviderManifest } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = resolve(here, '../../../tests/fixtures/fake-claude.sh');

const claudeStreamManifest: ProviderManifest = {
  id: 'claude',
  label: 'Claude',
  description: 'd',
  transport: 'cli',
  bin: FAKE_BIN,
  args: ['--print', '{prompt}'],
  outputFormat: 'claude-stream-json',
  promptVia: 'arg',
};

const plainManifest: ProviderManifest = {
  id: 'plain',
  label: 'Plain',
  description: 'd',
  transport: 'cli',
  bin: FAKE_BIN,
  args: ['{prompt}'],
  outputFormat: 'plain',
  promptVia: 'arg',
};

beforeEach(() => {
  delete process.env.FAKE_STDOUT_LINES;
  delete process.env.FAKE_DELAY_MS_BETWEEN_LINES;
  delete process.env.FAKE_SLEEP_MS_BEFORE_EXIT;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_STDERR;
  // The fake script ignores argv; ensure no INFLOOP_*_BIN overrides leak.
  delete process.env.INFLOOP_PROVIDER_BIN_CLAUDE;
  delete process.env.INFLOOP_CLAUDE_BIN;
  delete process.env.INFLOOP_EGRESS_ENFORCE;
});

afterEach(() => {
  delete process.env.FAKE_STDOUT_LINES;
});

describe('runProvider', () => {
  it('streams plain stdout lines verbatim and resolves with exitCode 0', async () => {
    process.env.FAKE_STDOUT_LINES = 'hello\nworld';
    const ctrl = new AbortController();
    const chunks: string[] = [];
    const result = await runProvider(plainManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
      onStdoutChunk: (line) => chunks.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('hello');
    expect(result.stdout).toContain('world');
    expect(chunks.join('')).toContain('hello');
  });

  it('parses claude stream-json text deltas into the stdout buffer', async () => {
    process.env.FAKE_STDOUT_LINES = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hi ' },
    }) + '\n' + JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'there' },
    });
    const ctrl = new AbortController();
    const result = await runProvider(claudeStreamManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Hi there');
  });

  it('captures stderr and propagates non-zero exit codes', async () => {
    process.env.FAKE_STDOUT_LINES = 'x';
    process.env.FAKE_STDERR = 'oops';
    process.env.FAKE_EXIT_CODE = '7';
    const ctrl = new AbortController();
    const result = await runProvider(plainManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('oops');
  });

  it('marks timedOut and kills the process when timeoutMs elapses', async () => {
    process.env.FAKE_STDOUT_LINES = '';
    process.env.FAKE_SLEEP_MS_BEFORE_EXIT = '5000';
    const ctrl = new AbortController();
    const start = Date.now();
    const result = await runProvider(plainManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 200,
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3500);
  });

  it('aborts when the AbortSignal fires', async () => {
    process.env.FAKE_STDOUT_LINES = '';
    process.env.FAKE_SLEEP_MS_BEFORE_EXIT = '5000';
    const ctrl = new AbortController();
    const promise = runProvider(plainManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 50);
    const result = await promise;
    expect(result.timedOut).toBe(false);
    // Killed via SIGTERM → exitCode is null.
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it('substitutes {prompt} into argv when promptVia is "arg"', async () => {
    // The fake script doesn't echo argv, so verify indirectly: with argv:
    // ['--print', '{prompt}'] and prompt='p', the script still runs cleanly.
    process.env.FAKE_STDOUT_LINES = 'ok';
    const ctrl = new AbortController();
    const result = await runProvider(claudeStreamManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBe(0);
  });

  it('delivers the prompt via stdin when promptVia is "stdin"', async () => {
    const stdinBin = resolve(here, '../../../tests/fixtures/fake-stdin-echo.sh');
    const stdinManifest: ProviderManifest = {
      id: 'stdin-echo',
      label: 'StdinEcho',
      description: 'd',
      transport: 'cli',
      bin: stdinBin,
      args: [],
      outputFormat: 'plain',
      promptVia: 'stdin',
    };
    const ctrl = new AbortController();
    const result = await runProvider(stdinManifest, {
      prompt: 'hello-from-stdin',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PROMPT_VIA_STDIN_BEGIN');
    expect(result.stdout).toContain('hello-from-stdin');
  });

  it('surfaces costUsd from a claude-stream-json result frame', async () => {
    process.env.FAKE_STDOUT_LINES = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0731,
    });
    const ctrl = new AbortController();
    const result = await runProvider(claudeStreamManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.0731);
  });

  it('takes the last cost when multiple result frames stream', async () => {
    // `total_cost_usd` is cumulative, so the final frame is the invocation
    // total — the runner must not sum frames.
    process.env.FAKE_STDOUT_LINES = [
      JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.1 }),
      JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.25 }),
    ].join('\n');
    const ctrl = new AbortController();
    const result = await runProvider(claudeStreamManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.costUsd).toBe(0.25);
  });

  it('leaves costUsd undefined for a provider that reports no cost', async () => {
    process.env.FAKE_STDOUT_LINES = 'hello';
    const ctrl = new AbortController();
    const result = await runProvider(plainManifest, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeUndefined();
  });

  describe('resolveCliArgs', () => {
    it('substitutes {prompt} in arg mode', () => {
      const out = resolveCliArgs(['--print', '{prompt}'], {
        prompt: 'hi',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--print', 'hi']);
    });

    it('leaves {prompt} alone in stdin mode (prompt delivered separately)', () => {
      const out = resolveCliArgs(['--print', '{prompt}'], {
        prompt: 'hi',
        promptVia: 'stdin',
      });
      expect(out).toEqual(['--print', '{prompt}']);
    });

    it('substitutes {agent} when value is set', () => {
      const out = resolveCliArgs(['--agent', '{agent}', '{prompt}'], {
        prompt: 'p',
        agent: 'code-review-agent',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--agent', 'code-review-agent', 'p']);
    });

    it('strips {agent} AND its preceding flag when agent is empty', () => {
      const out = resolveCliArgs(['--print', '--agent', '{agent}', '{prompt}'], {
        prompt: 'p',
        agent: '',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--print', 'p']);
    });

    it('strips the flag pair when agent is undefined', () => {
      const out = resolveCliArgs(['--agent', '{agent}', '{prompt}'], {
        prompt: 'p',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('treats a whitespace-only agent value as empty (strips the pair)', () => {
      const out = resolveCliArgs(['--agent', '{agent}', '{prompt}'], {
        prompt: 'p',
        agent: '   ',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('does not pop a non-flag token when {agent} is missing its flag', () => {
      // Manifest author put {agent} after the prompt placeholder, with no
      // preceding flag. Empty agent should drop just the placeholder, not
      // the prompt sitting in `out`.
      const out = resolveCliArgs(['{prompt}', '{agent}'], {
        prompt: 'p',
        agent: '',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('substitutes embedded {agent} (--agent={agent}) and drops it when empty', () => {
      const set = resolveCliArgs(['--agent={agent}', '{prompt}'], {
        prompt: 'p',
        agent: 'reviewer',
        promptVia: 'arg',
      });
      expect(set).toEqual(['--agent=reviewer', 'p']);

      const empty = resolveCliArgs(['--agent={agent}', '{prompt}'], {
        prompt: 'p',
        agent: '',
        promptVia: 'arg',
      });
      expect(empty).toEqual(['p']);
    });

    it('substitutes {mcpConfig} when value is set', () => {
      const out = resolveCliArgs(['--mcp-config', '{mcpConfig}', '{prompt}'], {
        prompt: 'p',
        mcpConfigPath: '/tmp/mcp.json',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--mcp-config', '/tmp/mcp.json', 'p']);
    });

    it('strips {mcpConfig} AND its preceding flag when path is empty', () => {
      const out = resolveCliArgs(
        ['--print', '--mcp-config', '{mcpConfig}', '{prompt}'],
        { prompt: 'p', mcpConfigPath: '', promptVia: 'arg' },
      );
      expect(out).toEqual(['--print', 'p']);
    });

    it('strips the {mcpConfig} flag pair when path is undefined', () => {
      const out = resolveCliArgs(['--mcp-config', '{mcpConfig}', '{prompt}'], {
        prompt: 'p',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('treats a whitespace-only mcpConfigPath as empty (strips the pair)', () => {
      const out = resolveCliArgs(['--mcp-config', '{mcpConfig}', '{prompt}'], {
        prompt: 'p',
        mcpConfigPath: '   ',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('handles {agent} and {mcpConfig} together with both set', () => {
      const out = resolveCliArgs(
        ['--agent', '{agent}', '--mcp-config', '{mcpConfig}', '{prompt}'],
        {
          prompt: 'p',
          agent: 'r',
          mcpConfigPath: '/tmp/m.json',
          promptVia: 'arg',
        },
      );
      expect(out).toEqual(['--agent', 'r', '--mcp-config', '/tmp/m.json', 'p']);
    });

    it('drops both flag pairs when both placeholders are empty', () => {
      const out = resolveCliArgs(
        ['--agent', '{agent}', '--mcp-config', '{mcpConfig}', '{prompt}'],
        { prompt: 'p', promptVia: 'arg' },
      );
      expect(out).toEqual(['p']);
    });

    it('expands and drops the Codex manifest profile and model placeholders', () => {
      const manifest = JSON.parse(
        readFileSync(resolve(here, '../../../providers/codex.json'), 'utf8'),
      ) as CliProviderManifest;

      expect(
        resolveCliArgs(manifest.args, { prompt: 'p', promptVia: 'arg' }),
      ).toEqual(['exec', '--skip-git-repo-check', 'p']);
      expect(
        resolveCliArgs(manifest.args, { prompt: 'p', profile: 'xxx', promptVia: 'arg' }),
      ).toEqual(['exec', '--skip-git-repo-check', '--profile', 'xxx', 'p']);
      expect(
        resolveCliArgs(manifest.args, {
          prompt: 'p',
          profile: 'xxx',
          model: 'gpt-5',
          promptVia: 'arg',
        }),
      ).toEqual([
        'exec',
        '--skip-git-repo-check',
        '--profile',
        'xxx',
        '--model',
        'gpt-5',
        'p',
      ]);
    });

    it('substitutes {profile} when value is set', () => {
      const out = resolveCliArgs(['--profile', '{profile}', '{prompt}'], {
        prompt: 'p',
        profile: 'xxx',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--profile', 'xxx', 'p']);
    });

    it('strips the {profile} flag pair when profile is empty', () => {
      const out = resolveCliArgs(['--profile', '{profile}', '{prompt}'], {
        prompt: 'p',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('strips the {profile} flag pair when profile is whitespace', () => {
      const out = resolveCliArgs(['--profile', '{profile}', '{prompt}'], {
        prompt: 'p',
        profile: '   ',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('substitutes {model} when value is set', () => {
      const out = resolveCliArgs(['--model', '{model}', '{prompt}'], {
        prompt: 'p',
        model: 'gpt-5',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--model', 'gpt-5', 'p']);
    });

    it('strips the {model} flag pair when model is empty', () => {
      const out = resolveCliArgs(['--model', '{model}', '{prompt}'], {
        prompt: 'p',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('strips the {model} flag pair when model is whitespace', () => {
      const out = resolveCliArgs(['--model', '{model}', '{prompt}'], {
        prompt: 'p',
        model: '   ',
        promptVia: 'arg',
      });
      expect(out).toEqual(['p']);
    });

    it('substitutes embedded {model} (--model={model}) and drops it when empty', () => {
      const set = resolveCliArgs(['--model={model}', '{prompt}'], {
        prompt: 'p',
        model: 'gpt-5',
        promptVia: 'arg',
      });
      expect(set).toEqual(['--model=gpt-5', 'p']);

      const empty = resolveCliArgs(['--model={model}', '{prompt}'], {
        prompt: 'p',
        promptVia: 'arg',
      });
      expect(empty).toEqual(['p']);
    });

    it('handles {agent}, {profile}, {model}, and {mcpConfig} together', () => {
      const out = resolveCliArgs(
        [
          '--agent', '{agent}',
          '--profile', '{profile}',
          '--model', '{model}',
          '--mcp-config', '{mcpConfig}',
          '{prompt}',
        ],
        {
          prompt: 'p',
          agent: 'r',
          profile: 'xxx',
          model: 'gpt-5',
          mcpConfigPath: '/tmp/m.json',
          promptVia: 'arg',
        },
      );
      expect(out).toEqual([
        '--agent', 'r',
        '--profile', 'xxx',
        '--model', 'gpt-5',
        '--mcp-config', '/tmp/m.json',
        'p',
      ]);
    });

    it('expands {dangerousArgs} to every supplied arg in place', () => {
      const out = resolveCliArgs(['{dangerousArgs}', '--print', '{prompt}'], {
        prompt: 'p',
        dangerousArgs: ['--dangerously-skip-permissions'],
        promptVia: 'arg',
      });
      expect(out).toEqual(['--dangerously-skip-permissions', '--print', 'p']);
    });

    it('drops {dangerousArgs} to nothing when the list is empty', () => {
      const out = resolveCliArgs(['{dangerousArgs}', '--print', '{prompt}'], {
        prompt: 'p',
        dangerousArgs: [],
        promptVia: 'arg',
      });
      expect(out).toEqual(['--print', 'p']);
    });

    it('drops {dangerousArgs} to nothing when the list is undefined', () => {
      const out = resolveCliArgs(['{dangerousArgs}', '--print', '{prompt}'], {
        prompt: 'p',
        promptVia: 'arg',
      });
      expect(out).toEqual(['--print', 'p']);
    });

    it('expands {dangerousArgs} after a leading subcommand', () => {
      const out = resolveCliArgs(['exec', '{dangerousArgs}', '{prompt}'], {
        prompt: 'p',
        dangerousArgs: ['--full-auto'],
        promptVia: 'arg',
      });
      expect(out).toEqual(['exec', '--full-auto', 'p']);
    });
  });

  describe('dangerousArgs gating', () => {
    const ARGV_ECHO = resolve(here, '../../../tests/fixtures/fake-argv-echo.sh');
    const dangerManifest: ProviderManifest = {
      id: 'danger',
      label: 'Danger',
      description: 'd',
      transport: 'cli',
      bin: ARGV_ECHO,
      args: ['{dangerousArgs}', '{prompt}'],
      dangerousArgs: ['--dangerously-skip-permissions'],
      outputFormat: 'plain',
      promptVia: 'arg',
    };

    it('injects manifest.dangerousArgs only when the node opts in', async () => {
      const ctrl = new AbortController();
      const result = await runProvider(dangerManifest, {
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: ctrl.signal,
        dangerouslySkipPermissions: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ARG:--dangerously-skip-permissions');
    });

    it('omits manifest.dangerousArgs when the node has not opted in', async () => {
      const ctrl = new AbortController();
      const result = await runProvider(dangerManifest, {
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: ctrl.signal,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--dangerously-skip-permissions');
      expect(result.stdout).toContain('ARG:p');
    });
  });

  describe('resolveEgressEnforcement', () => {
    const base: CliProviderManifest = {
      id: 'eg',
      label: 'EG',
      description: 'd',
      transport: 'cli',
      bin: 'x',
      args: [],
      outputFormat: 'plain',
      promptVia: 'arg',
    };

    it('returns null when INFLOOP_EGRESS_ENFORCE is unset', () => {
      const m = { ...base, egressAllowlist: ['api.anthropic.com'] };
      expect(resolveEgressEnforcement(m, {})).toBeNull();
    });

    it('returns null when enforcement is on but no allowlist is declared', () => {
      expect(
        resolveEgressEnforcement(base, { INFLOOP_EGRESS_ENFORCE: '1' }),
      ).toBeNull();
    });

    it('returns the allowlist when enforcement is on and one is declared', () => {
      const m = { ...base, egressAllowlist: ['api.anthropic.com'] };
      expect(
        resolveEgressEnforcement(m, { INFLOOP_EGRESS_ENFORCE: '1' }),
      ).toEqual(['api.anthropic.com']);
    });

    it('returns an empty declared allowlist as-is (deliberate no-network posture)', () => {
      const m = { ...base, egressAllowlist: [] };
      expect(
        resolveEgressEnforcement(m, { INFLOOP_EGRESS_ENFORCE: '1' }),
      ).toEqual([]);
    });
  });

  describe('egress enforcement wiring', () => {
    const ENV_ECHO = resolve(here, '../../../tests/fixtures/fake-env-echo.sh');
    const egressManifest: ProviderManifest = {
      id: 'eg',
      label: 'EG',
      description: 'd',
      transport: 'cli',
      bin: ENV_ECHO,
      args: [],
      outputFormat: 'plain',
      promptVia: 'arg',
      egressAllowlist: ['api.anthropic.com'],
    };

    it('routes the child through a loopback proxy when enforcement is on', async () => {
      process.env.INFLOOP_EGRESS_ENFORCE = '1';
      const ctrl = new AbortController();
      const result = await runProvider(egressManifest, {
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: ctrl.signal,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(
        /ENV:HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/,
      );
      expect(result.stdout).toMatch(/ENV:NO_PROXY=[^\n]*127\.0\.0\.1/);
    });

    it('leaves the child env unproxied when enforcement is off', async () => {
      // INFLOOP_EGRESS_ENFORCE is cleared by beforeEach.
      const ctrl = new AbortController();
      const result = await runProvider(egressManifest, {
        prompt: 'p',
        cwd: process.cwd(),
        timeoutMs: 5000,
        signal: ctrl.signal,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(
        /ENV:HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/,
      );
    });
  });

  it('returns null exitCode + helpful stderr when binary spawn fails', async () => {
    const broken: ProviderManifest = {
      ...plainManifest,
      bin: '/no/such/binary/anywhere',
    };
    const ctrl = new AbortController();
    const result = await runProvider(broken, {
      prompt: 'p',
      cwd: process.cwd(),
      timeoutMs: 1000,
      signal: ctrl.signal,
    });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/spawn error/);
  });
});
