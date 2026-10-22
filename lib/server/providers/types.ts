/*
 * Provider manifest — the shape of a `providers/*.json` file.
 *
 * v1 scope: stdout-text providers with single positional `{prompt}`
 * substitution (or via stdin). Out of scope: auth, multi-token
 * templates, hot reload, per-provider extra config knobs.
 *
 * v2 (this file): adds `transport: "http"` for remote OpenAI-compatible
 * APIs (Hermes / OpenRouter / vLLM / …). Existing CLI providers keep
 * working unchanged — `transport` defaults to "cli".
 */

export type ProviderTransport = 'cli' | 'http';

/** Discriminator for providers loaded from the user-managed
 * `<id>.hermes.local.json` files. The palette uses this to group them
 * under their own collapsible section so the user can manage them
 * separately from committed CLI / HTTP providers. */
export type ProviderKind = 'hermes-local' | 'openai-local';

interface ProviderManifestCommon {
  id: string;
  label: string;
  description: string;
  glyph?: string;
  /** Always present after validation. Manifest files may omit it — the
   * loader defaults a missing value to "cli". */
  transport: ProviderTransport;
  /** Set by the loader when the manifest came from a recognized
   * user-managed file (e.g. `*.hermes.local.json`). Absent for committed
   * `*.json` manifests. */
  kind?: ProviderKind;
  /** For manifests expanded from a multi-profile parent (a single
   * `*.hermes.local.json` connection produces one manifest per port),
   * this points back at the parent so the UI can group them. */
  connectionId?: string;
  /** Human label of the parent connection, used as the sub-header in
   * the grouped palette view. */
  connectionLabel?: string;
}

export interface CliProviderManifest extends ProviderManifestCommon {
  transport: 'cli';
  bin: string;
  args: string[];
  outputFormat: string;
  /** How the prompt is delivered. Default `"arg"` substitutes `{prompt}`
   * inside `args`. `"stdin"` writes the prompt to the child's stdin and
   * leaves `args` untouched (no `{prompt}` substitution). */
  promptVia: 'arg' | 'stdin';
  /** Host environment variables this CLI needs, on top of the base allowlist
   * every spawned child receives. Entries are exact names or `PREFIX_*`
   * trailing wildcards. The child is spawned with a scrubbed environment
   * (see lib/server/child-env.ts) — a variable that is neither on the base
   * list nor named here is not visible to the CLI. Entries may not target
   * the reserved `INFLOOP_` namespace; the loader rejects ones that do. */
  envPassthrough?: string[];
  /** Extra argv the runner injects in place of the `{dangerousArgs}`
   * placeholder ONLY when an Agent node explicitly opts into the dangerous,
   * un-sandboxed posture (`AgentConfig.dangerouslySkipPermissions`). When
   * the node has not opted in, `{dangerousArgs}` expands to nothing. For the
   * Claude CLI this is `["--dangerously-skip-permissions"]`. */
  dangerousArgs?: string[];
  /** Required leading CLI args when per-worker HOME/CODEX_HOME are configured. */
  homeOverrideArgs?: string[];
  /** Network hosts this CLI's child process is allowed to reach. Each entry is
   * a hostname — exact (`api.anthropic.com`) or a leading-wildcard
   * (`*.anthropic.com`, matching any subdomain but NOT the apex). When the
   * operator opts into enforcement with `INFLOOP_EGRESS_ENFORCE=1`, the runner
   * routes the child's HTTP(S) traffic through a per-run filtering proxy that
   * permits only these hosts and refuses everything else. Absent → no proxy,
   * unrestricted egress (the default). See lib/server/egress-proxy.ts. */
  egressAllowlist?: string[];
}

export interface HttpProviderAuth {
  type: 'bearer';
  /** Name of the env var holding the bearer token. Used by committed
   * manifests so the secret never lives on disk alongside them. Exactly
   * one of `envVar` or `token` must be set. */
  envVar?: string;
  /** Inline bearer token. Only meant for gitignored local manifests
   * (`*.local.json`) where the user has explicitly opted into storing the
   * secret on disk via the UI. Exactly one of `envVar` or `token` must be
   * set. */
  token?: string;
}

export interface HttpProviderProfile {
  id: string;
  label?: string;
}

export interface HttpProviderManifest extends ProviderManifestCommon {
  transport: 'http';
  /** Base URL with no trailing slash, e.g. "https://hermes.example/v1". */
  baseUrl: string;
  /** Path appended to baseUrl for the Responses API call. Must be
   * `/responses` at execution time. */
  endpoint: string;
  /** Optional path for live profile discovery (e.g. "/models"). */
  profilesEndpoint?: string;
  auth?: HttpProviderAuth;
  /** Extra provider-specific headers. Runtime-owned headers (authorization,
   * content-type and accept) always take precedence. */
  headers?: Record<string, string>;
  /** Optional OpenAI-compatible request parameters. Runtime-owned fields
   * (`model`, `input`, `stream`, `text`, `messages`, `response_format`, and
   * `n`) are protected
   * and cannot be overridden by this object. */
  requestOptions?: Record<string, unknown>;
  /** Static fallback list, used when the live fetch fails or
   * `profilesEndpoint` is unset. */
  profiles?: HttpProviderProfile[];
  /** Profile id used when the agent node didn't pick one. */
  defaultProfile?: string;
}

export type ProviderManifest = CliProviderManifest | HttpProviderManifest;

/** Public summary shipped to the client palette via `/api/providers`. */
export type ProviderHealthStatus = 'available' | 'missing' | 'unknown';

export interface ProviderHealth {
  status: ProviderHealthStatus;
  message?: string;
  resolvedBin?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  glyph?: string;
  transport: ProviderTransport;
  kind?: ProviderKind;
  connectionId?: string;
  connectionLabel?: string;
  /** True when the provider can be selected/run with high confidence. For
   * CLI providers this means the configured executable resolves in PATH or
   * exists at its absolute/relative path; HTTP providers are marked true but
   * health remains `unknown` because remote auth/network health is checked at
   * run time. */
  available: boolean;
  health: ProviderHealth;
  /** True when the CLI manifest declares a `{profile}` placeholder. */
  manifestSupportsProfile?: boolean;
  /** True when the CLI manifest declares a `{model}` placeholder. */
  manifestSupportsModel?: boolean;
  /** True when the CLI manifest declares an `{agent}` placeholder. */
  manifestSupportsAgent?: boolean;
  manifestSupportsHomeOverrides?: boolean;
}
