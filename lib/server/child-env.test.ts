import { describe, expect, it } from 'bun:test';
import { buildChildEnv, OPERATOR_PASSTHROUGH_VAR } from './child-env';

describe('buildChildEnv', () => {
  it('passes base-allowlist variables through and nothing else', () => {
    const env = buildChildEnv(
      {},
      { PATH: '/usr/bin', HOME: '/home/x', TERM: 'xterm' },
      'linux',
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.TERM).toBe('xterm');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TERM']);
  });

  it('strips variables that are not on any allowlist', () => {
    const env = buildChildEnv(
      {},
      { PATH: '/usr/bin', MY_SECRET: 'shh', AWS_SECRET_ACCESS_KEY: 'k' },
      'linux',
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('never passes an INFLOOP_ variable, even when explicitly allowlisted', () => {
    const env = buildChildEnv(
      { passthrough: ['INFLOOP_API_TOKEN', 'INFLOOP_*'] },
      { PATH: '/b', INFLOOP_API_TOKEN: 'top-secret', INFLOOP_DATA_DIR: '/d' },
      'linux',
    );
    expect(env.PATH).toBe('/b');
    expect(env.INFLOOP_API_TOKEN).toBeUndefined();
    expect(env.INFLOOP_DATA_DIR).toBeUndefined();
  });

  it('never passes an INFLOOP_ variable named via the operator passthrough', () => {
    const env = buildChildEnv(
      {},
      {
        PATH: '/b',
        INFLOOP_API_TOKEN: 'top-secret',
        [OPERATOR_PASSTHROUGH_VAR]: 'INFLOOP_API_TOKEN',
      },
      'linux',
    );
    expect(env.INFLOOP_API_TOKEN).toBeUndefined();
  });

  it('honors a manifest passthrough exact name', () => {
    const env = buildChildEnv(
      { passthrough: ['ANTHROPIC_API_KEY'] },
      { PATH: '/b', ANTHROPIC_API_KEY: 'ak', OPENAI_API_KEY: 'ok' },
      'linux',
    );
    expect(env.ANTHROPIC_API_KEY).toBe('ak');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('honors a manifest passthrough PREFIX_* wildcard', () => {
    const env = buildChildEnv(
      { passthrough: ['ANTHROPIC_*'] },
      { ANTHROPIC_API_KEY: 'ak', ANTHROPIC_BASE_URL: 'u', OTHER: 'x' },
      'linux',
    );
    expect(env.ANTHROPIC_API_KEY).toBe('ak');
    expect(env.ANTHROPIC_BASE_URL).toBe('u');
    expect(env.OTHER).toBeUndefined();
  });

  it('merges the operator passthrough on top of the base + manifest sets', () => {
    const env = buildChildEnv(
      { passthrough: ['CLAUDE_*'] },
      {
        PATH: '/b',
        CLAUDE_CONFIG_DIR: '/c',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GH_TOKEN: 'gt',
        [OPERATOR_PASSTHROUGH_VAR]: 'SSH_AUTH_SOCK, GH_*',
      },
      'linux',
    );
    expect(env.PATH).toBe('/b');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(env.GH_TOKEN).toBe('gt');
  });

  it('ignores a bare "*" passthrough entry — it does not allow everything', () => {
    const env = buildChildEnv(
      { passthrough: ['*'] },
      { PATH: '/b', MY_SECRET: 'shh' },
      'linux',
    );
    expect(env.PATH).toBe('/b');
    expect(env.MY_SECRET).toBeUndefined();
  });

  it('passes XDG base-directory paths via the base allowlist', () => {
    const env = buildChildEnv(
      {},
      { XDG_CACHE_HOME: '/x/cache', XDG_CONFIG_HOME: '/x/config' },
      'linux',
    );
    expect(env.XDG_CACHE_HOME).toBe('/x/cache');
    expect(env.XDG_CONFIG_HOME).toBe('/x/config');
  });

  it('passes LC_* locale variables via the base prefix', () => {
    const env = buildChildEnv(
      {},
      { LC_ALL: 'C', LC_CTYPE: 'UTF-8', LCD: 'not-a-locale' },
      'linux',
    );
    expect(env.LC_ALL).toBe('C');
    expect(env.LC_CTYPE).toBe('UTF-8');
    expect(env.LCD).toBeUndefined();
  });

  it('skips variables whose value is undefined', () => {
    const env = buildChildEnv({}, { PATH: '/b', HOME: undefined }, 'linux');
    expect(env.PATH).toBe('/b');
    expect('HOME' in env).toBe(false);
  });

  it('matches names case-insensitively on Windows', () => {
    const env = buildChildEnv(
      {},
      { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
      'win32',
    );
    expect(env.Path).toBe('C:\\Windows');
    expect(env.SystemRoot).toBe('C:\\Windows');
  });

  it('matches names case-sensitively off Windows', () => {
    const env = buildChildEnv({}, { path: '/lower' }, 'linux');
    expect(env.path).toBeUndefined();
  });

  it('applies overrides on top of the allowlist', () => {
    const env = buildChildEnv(
      { overrides: { HTTPS_PROXY: 'http://127.0.0.1:9' } },
      { PATH: '/usr/bin' },
      'linux',
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9');
  });

  it('lets an override win over an inherited base-allowlist value', () => {
    // HTTP_PROXY is on the base allowlist, so the inherited host value would
    // otherwise pass through — the override must replace it.
    const env = buildChildEnv(
      { overrides: { HTTP_PROXY: 'http://127.0.0.1:9' } },
      { HTTP_PROXY: 'http://corp-proxy:8080' },
      'linux',
    );
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9');
  });

  it('never lets an override write into the INFLOOP_ namespace', () => {
    const env = buildChildEnv(
      { overrides: { INFLOOP_API_TOKEN: 'leak', SAFE: 'ok' } },
      {},
      'linux',
    );
    expect(env.INFLOOP_API_TOKEN).toBeUndefined();
    expect(env.SAFE).toBe('ok');
  });
});
