/*
 * Child-process environment scrubbing.
 *
 * Provider CLIs (the Agent node) and inline TS/Python (the Script node) run
 * untrusted code: AI-authored, and routinely shaped by webhook payloads the
 * server does not control. Spawning them with an inherited `process.env`
 * hands that code every secret the orchestrator holds — most dangerously
 * `INFLOOP_API_TOKEN`, the bearer token gating the entire API surface, but
 * also any cloud credential, SSH-agent socket, or registry token that
 * happened to be in the server's environment.
 *
 * `buildChildEnv` replaces inheritance with an explicit allowlist. A spawned
 * child receives only:
 *   1. a small base set of non-secret, environment-shaping variables every
 *      process needs (PATH, HOME, locale, TLS/proxy config, …);
 *   2. the variables a provider manifest explicitly declares it needs via
 *      `envPassthrough` (e.g. the Claude CLI needs `ANTHROPIC_*`);
 *   3. anything the operator opts into through `INFLOOP_CHILD_ENV_PASSTHROUGH`
 *      — the escape hatch for site-specific needs (a Bedrock `AWS_*`, an
 *      `SSH_AUTH_SOCK`, a Python venv).
 *
 * Hard rule: a variable in the `INFLOOP_` namespace is NEVER passed to a
 * child, no matter what an allowlist or passthrough entry says. That is the
 * orchestrator's own configuration/secret namespace; nothing a child runs
 * has any business reading it.
 */

/** Operator-controlled passthrough list: comma-separated variable names or
 *  `PREFIX_*` wildcards, merged on top of the base + manifest allowlists.
 *  Itself an `INFLOOP_` variable, so it never reaches a child. */
export const OPERATOR_PASSTHROUGH_VAR = 'INFLOOP_CHILD_ENV_PASSTHROUGH';

/** The namespace that never reaches a child process — see the hard rule. */
const FORBIDDEN_PREFIX = 'INFLOOP_';

/*
 * Base allowlist — non-secret variables that shape how *any* process runs:
 * where to find its interpreter, how to render output, which locale/timezone
 * to use, and how to resolve TLS and proxies. None of these is a credential.
 *
 * Deliberately omitted: `PWD` (the child's spawn `cwd` already sets it; a
 * stale inherited value is misleading) and anything credential-bearing.
 */
const BASE_ALLOW_EXACT: readonly string[] = [
  // Process / interpreter discovery.
  'PATH',
  'HOME',
  'BUN_INSTALL',
  // Non-secret runtime mode — shapes how Node/Bun and many libraries behave.
  'NODE_ENV',
  // Identity — non-secret; tools read them for config paths and git.
  'USER',
  'LOGNAME',
  'SHELL',
  // Terminal / output rendering.
  'TERM',
  'COLORTERM',
  // Locale & timezone.
  'LANG',
  'LANGUAGE',
  'TZ',
  // Temp dir.
  'TMPDIR',
  'TEMP',
  'TMP',
  // XDG base directories — config/cache/data *paths* (not secrets) that
  // CLIs, and Bun's transpile cache, resolve their working files against.
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  // Misc non-secret.
  'HOSTNAME',
  '__CF_USER_TEXT_ENCODING',
  // TLS trust — a child `fetch` / `git` / `curl` needs these behind a
  // custom CA. Cert *paths*, not secrets.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Proxy config — endpoints, not credentials.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // Windows: the platform equivalents of PATH/HOME/TEMP plus CPU/arch info.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'OS',
];

/** Base allowlist wildcards — `LC_*` covers the locale category vars.
 *  Entries use the same trailing-`*` syntax as a manifest `envPassthrough`. */
const BASE_ALLOW_PREFIX: readonly string[] = ['LC_*'];

export interface ChildEnvOptions {
  /** Extra variable names / `PREFIX_*` wildcards to allow through on top of
   *  the base set — sourced from a provider manifest's `envPassthrough`. */
  passthrough?: readonly string[];
  /** Variables the orchestrator sets itself — NOT inherited from the host env.
   *  Used to route a child's HTTP(S) egress through a per-run filtering proxy
   *  (`HTTP_PROXY`, `NO_PROXY`, …). Applied after the allowlist and
   *  unconditionally overriding any same-named base/inherited value. The
   *  `INFLOOP_` hard rule is still enforced on override keys. */
  overrides?: Record<string, string>;
}

interface CompiledAllowlist {
  exact: Set<string>;
  prefixes: string[];
}

/** Fold a name for comparison: env var names are case-insensitive on Windows
 *  (`Path` === `PATH`), case-sensitive everywhere else. */
function folder(platform: NodeJS.Platform): (s: string) => string {
  return platform === 'win32' ? (s) => s.toUpperCase() : (s) => s;
}

/** Compile a base + extra pattern set into exact names and trailing-wildcard
 *  prefixes. A pattern ending in `*` is a prefix match on the part before it;
 *  a bare `*` (empty prefix) is ignored — it would allow everything and is
 *  never a deliberate allowlist entry. */
function compile(
  patterns: Iterable<string>,
  fold: (s: string) => string,
): CompiledAllowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (p.length === 0) continue;
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (prefix.length > 0) prefixes.push(fold(prefix));
    } else {
      exact.add(fold(p));
    }
  }
  return { exact, prefixes };
}

/**
 * Build the environment for a spawned child: an explicit allowlist applied to
 * `sourceEnv`, never the raw inherited env. See the file header for the model.
 *
 * Pure and parameterized for testing — `sourceEnv` and `platform` default to
 * the live process values in production. The result is typed `ProcessEnv` so
 * it drops straight into a `spawn` `env` option.
 */
export function buildChildEnv(
  opts: ChildEnvOptions = {},
  sourceEnv: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const fold = folder(platform);

  const patterns: string[] = [...BASE_ALLOW_EXACT, ...BASE_ALLOW_PREFIX];
  if (opts.passthrough) patterns.push(...opts.passthrough);
  const operator = sourceEnv[OPERATOR_PASSTHROUGH_VAR];
  if (typeof operator === 'string') patterns.push(...operator.split(','));

  const { exact, prefixes } = compile(patterns, fold);
  const forbidden = fold(FORBIDDEN_PREFIX);

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    const key = fold(name);
    // Hard rule: the orchestrator's own namespace never leaves, even if a
    // passthrough entry would match it.
    if (key.startsWith(forbidden)) continue;
    if (exact.has(key) || prefixes.some((pre) => key.startsWith(pre))) {
      out[name] = value;
    }
  }
  // Orchestrator-set overrides: applied last so they win over any inherited
  // base value (notably a host `HTTP_PROXY`), bypassing the allowlist because
  // they are our own values, not host secrets. The `INFLOOP_` hard rule still
  // holds — nothing in that namespace reaches a child by any path.
  if (opts.overrides) {
    for (const [name, value] of Object.entries(opts.overrides)) {
      if (fold(name).startsWith(forbidden)) continue;
      out[name] = value;
    }
  }
  // Cast: a scrubbed allowlist is a valid child environment. `ProcessEnv` is
  // augmented (by Next) to mark `NODE_ENV` required — the same imprecision
  // `@types/node` already accepts for `process.env` itself.
  return out as NodeJS.ProcessEnv;
}
