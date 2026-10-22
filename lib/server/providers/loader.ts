import { promises as fs } from 'node:fs';
import path from 'node:path';
import { connectionsDir } from '../paths';
import { KNOWN_OUTPUT_FORMATS } from './parsers/index';
import type {
  CliProviderManifest,
  HttpProviderAuth,
  HttpProviderManifest,
  HttpProviderProfile,
  ProviderManifest,
  ProviderTransport,
} from './types';
import { createLogger } from '../logger';

const log = createLogger('providers');

function providersDir(): string {
  return (
    process.env.INFLOOP_PROVIDERS_DIR || path.join(process.cwd(), 'providers')
  );
}

/**
 * Resolve the binary for a CLI-transport provider. Order:
 *   1. `INFLOOP_PROVIDER_BIN_<ID>` env override (id upper-cased).
 *   2. `INFLOOP_CLAUDE_BIN` for the legacy claude-only override.
 *   3. The manifest's declared `bin`.
 *
 * HTTP-transport manifests have no `bin` and never reach this function.
 */
export function resolveBin(manifest: CliProviderManifest): string {
  const idEnv = `INFLOOP_PROVIDER_BIN_${manifest.id.toUpperCase()}`;
  const fromIdEnv = process.env[idEnv];
  if (fromIdEnv) return fromIdEnv;
  if (manifest.id === 'claude' && process.env.INFLOOP_CLAUDE_BIN) {
    return process.env.INFLOOP_CLAUDE_BIN;
  }
  return manifest.bin;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateCommon(
  m: Record<string, unknown>,
  file: string,
): {
  id: string;
  label: string;
  description: string;
  glyph?: string;
  kind?: 'hermes-local';
} {
  for (const key of ['id', 'label', 'description']) {
    if (!isNonEmptyString(m[key])) {
      throw new Error(`provider ${file}: \`${key}\` must be a non-empty string`);
    }
  }
  if (m.glyph !== undefined && typeof m.glyph !== 'string') {
    throw new Error(`provider ${file}: \`glyph\` must be a string if set`);
  }
  // `kind` is only set by `applyHermesLocalDefaults` for files this
  // process knows about — never trust a raw value from the manifest body.
  const kind = m.kind === 'hermes-local' ? 'hermes-local' : undefined;
  return {
    id: m.id as string,
    label: m.label as string,
    description: m.description as string,
    glyph: m.glyph as string | undefined,
    kind,
  };
}

/**
 * Validate a CLI manifest's `envPassthrough`: a list of host env var names or
 * `PREFIX_*` trailing wildcards the provider's child process is allowed to
 * see (see lib/server/child-env.ts). Rejects anything malformed, a bare `*`
 * (which would leak the whole host environment), a non-trailing `*`, and any
 * entry that targets the reserved `INFLOOP_` namespace — failing loud at load
 * time rather than relying solely on the runtime hard rule.
 */
function validateEnvPassthrough(
  raw: unknown,
  file: string,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!isStringArray(raw)) {
    throw new Error(
      `provider ${file}: \`envPassthrough\` must be a string array if set`,
    );
  }
  // Return the trimmed entries so the stored manifest matches what the
  // runtime allowlist actually applies (every other validated field in this
  // loader is normalized on the way out).
  const cleaned: string[] = [];
  for (const entry of raw) {
    const e = entry.trim();
    if (e.length === 0) {
      throw new Error(
        `provider ${file}: \`envPassthrough\` entries must be non-empty`,
      );
    }
    if (e === '*') {
      throw new Error(
        `provider ${file}: \`envPassthrough\` may not contain a bare "*" — it would pass the entire host environment`,
      );
    }
    const star = e.indexOf('*');
    if (star !== -1 && star !== e.length - 1) {
      throw new Error(
        `provider ${file}: \`envPassthrough\` entry "${e}" — "*" is only allowed as a trailing wildcard`,
      );
    }
    const isWildcard = e.endsWith('*');
    const prefix = (isWildcard ? e.slice(0, -1) : e).toUpperCase();
    if (prefix.startsWith('INFLOOP_') || (isWildcard && 'INFLOOP_'.startsWith(prefix))) {
      throw new Error(
        `provider ${file}: \`envPassthrough\` entry "${e}" targets the reserved INFLOOP_ namespace`,
      );
    }
    cleaned.push(e);
  }
  return cleaned;
}

/**
 * Validate a CLI manifest's `egressAllowlist`: a list of hostnames the
 * provider's child process is permitted to reach when egress enforcement is on
 * (see lib/server/egress-proxy.ts). Each entry is an exact hostname or a
 * leading-wildcard `*.suffix`. Rejects empty entries, a bare `*`, a non-leading
 * `*`, and anything carrying a scheme, port, path, or whitespace. Entries are
 * lowercased on the way out so the stored manifest matches what the runtime
 * matcher (also case-insensitive) applies.
 */
function validateEgressAllowlist(
  raw: unknown,
  file: string,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!isStringArray(raw)) {
    throw new Error(
      `provider ${file}: \`egressAllowlist\` must be a string array if set`,
    );
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    const e = entry.trim().toLowerCase();
    if (e.length === 0) {
      throw new Error(
        `provider ${file}: \`egressAllowlist\` entries must be non-empty`,
      );
    }
    if (e === '*') {
      throw new Error(
        `provider ${file}: \`egressAllowlist\` may not contain a bare "*" — it would allow every host`,
      );
    }
    if (e.includes('*') && !e.startsWith('*.')) {
      throw new Error(
        `provider ${file}: \`egressAllowlist\` entry "${e}" — "*" is only allowed as a leading "*." wildcard`,
      );
    }
    const host = e.startsWith('*.') ? e.slice(2) : e;
    // A plain hostname: dot-separated labels, no scheme, port, path, or
    // residual wildcard. IPv4 literals are accepted (digits are valid labels).
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
        host,
      )
    ) {
      throw new Error(
        `provider ${file}: \`egressAllowlist\` entry "${e}" is not a valid hostname (no scheme, port, path, or wildcard beyond a leading "*.")`,
      );
    }
    cleaned.push(e);
  }
  return cleaned;
}

function validateCliManifest(
  m: Record<string, unknown>,
  file: string,
): CliProviderManifest {
  const common = validateCommon(m, file);
  if (!isNonEmptyString(m.bin)) {
    throw new Error(`provider ${file}: \`bin\` must be a non-empty string`);
  }
  if (!isNonEmptyString(m.outputFormat)) {
    throw new Error(`provider ${file}: \`outputFormat\` must be a non-empty string`);
  }
  if (!isStringArray(m.args)) {
    throw new Error(`provider ${file}: \`args\` must be a string array`);
  }
  if (!KNOWN_OUTPUT_FORMATS.includes(m.outputFormat as string)) {
    throw new Error(
      `provider ${file}: unknown outputFormat "${m.outputFormat}". Known: ${KNOWN_OUTPUT_FORMATS.join(', ')}`,
    );
  }
  if (
    m.promptVia !== undefined &&
    m.promptVia !== 'arg' &&
    m.promptVia !== 'stdin'
  ) {
    throw new Error(
      `provider ${file}: \`promptVia\` must be "arg" or "stdin" if set`,
    );
  }
  if (m.dangerousArgs !== undefined && !isStringArray(m.dangerousArgs)) {
    throw new Error(
      `provider ${file}: \`dangerousArgs\` must be a string array if set`,
    );
  }
  if (m.homeOverrideArgs !== undefined && (
    !isStringArray(m.homeOverrideArgs) || m.homeOverrideArgs.length === 0 ||
    m.homeOverrideArgs.some((arg) => !arg.trim() || arg.includes('\0'))
  )) {
    throw new Error(`provider ${file}: \`homeOverrideArgs\` must be a nonempty array of nonempty strings`);
  }
  return {
    ...common,
    transport: 'cli',
    bin: m.bin as string,
    args: m.args as string[],
    outputFormat: m.outputFormat as string,
    promptVia: (m.promptVia as 'arg' | 'stdin' | undefined) ?? 'arg',
    envPassthrough: validateEnvPassthrough(m.envPassthrough, file),
    dangerousArgs: m.dangerousArgs as string[] | undefined,
    homeOverrideArgs: m.homeOverrideArgs as string[] | undefined,
    egressAllowlist: validateEgressAllowlist(m.egressAllowlist, file),
  };
}

function validateHttpAuth(raw: unknown, file: string): HttpProviderAuth | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`provider ${file}: \`auth\` must be an object if set`);
  }
  const auth = raw as Record<string, unknown>;
  if (auth.type !== 'bearer') {
    throw new Error(`provider ${file}: \`auth.type\` must be "bearer" (only kind supported)`);
  }
  const hasEnvVar = isNonEmptyString(auth.envVar);
  const hasToken = isNonEmptyString(auth.token);
  if (hasEnvVar && hasToken) {
    throw new Error(
      `provider ${file}: \`auth\` must set exactly one of \`envVar\` or \`token\``,
    );
  }
  if (!hasEnvVar && !hasToken) {
    throw new Error(
      `provider ${file}: \`auth\` must set either \`envVar\` or \`token\``,
    );
  }
  return hasEnvVar
    ? { type: 'bearer', envVar: auth.envVar as string }
    : { type: 'bearer', token: auth.token as string };
}

function validateHttpProfiles(
  raw: unknown,
  file: string,
): HttpProviderProfile[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`provider ${file}: \`profiles\` must be an array if set`);
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`provider ${file}: \`profiles[${i}]\` must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.id)) {
      throw new Error(`provider ${file}: \`profiles[${i}].id\` must be a non-empty string`);
    }
    if (e.label !== undefined && typeof e.label !== 'string') {
      throw new Error(`provider ${file}: \`profiles[${i}].label\` must be a string if set`);
    }
    return { id: e.id, label: e.label as string | undefined };
  });
}

function validateHttpHeaders(
  raw: unknown,
  file: string,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`provider ${file}: \`headers\` must be an object if set`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // Field-name grammar from RFC 9110. Keeping this strict prevents a local
    // configuration file from injecting a second HTTP header via CRLF.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`provider ${file}: \`headers\` has an invalid header name "${name}"`);
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new Error(`provider ${file}: \`headers.${name}\` must be a single-line string`);
    }
    headers[name] = value;
  }
  return headers;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function validateRequestOptions(
  raw: unknown,
  file: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isJsonValue(raw)) {
    throw new Error(`provider ${file}: \`requestOptions\` must be a JSON object if set`);
  }
  return raw as Record<string, unknown>;
}

function validateHttpManifest(
  m: Record<string, unknown>,
  file: string,
): HttpProviderManifest {
  const common = validateCommon(m, file);
  if (!isNonEmptyString(m.baseUrl)) {
    throw new Error(`provider ${file}: \`baseUrl\` must be a non-empty string`);
  }
  if (!isNonEmptyString(m.endpoint)) {
    throw new Error(`provider ${file}: \`endpoint\` must be a non-empty string`);
  }
  // Endpoints are joined with `baseUrl` via raw concatenation in the runner —
  // both halves MUST be deliberate about the boundary. We require a leading
  // slash here so a typo can't silently produce `https://host/v1chat/...`.
  if (!(m.endpoint as string).startsWith('/')) {
    throw new Error(`provider ${file}: \`endpoint\` must start with "/"`);
  }
  if (m.profilesEndpoint !== undefined) {
    if (typeof m.profilesEndpoint !== 'string') {
      throw new Error(`provider ${file}: \`profilesEndpoint\` must be a string if set`);
    }
    if (!(m.profilesEndpoint as string).startsWith('/')) {
      throw new Error(`provider ${file}: \`profilesEndpoint\` must start with "/"`);
    }
  }
  if (m.defaultProfile !== undefined && typeof m.defaultProfile !== 'string') {
    throw new Error(`provider ${file}: \`defaultProfile\` must be a string if set`);
  }
  // `envPassthrough` / `dangerousArgs` / `egressAllowlist` shape how a *spawned
  // child process* is built; an HTTP provider spawns nothing, so naming them is
  // a manifest mistake worth surfacing rather than silently ignoring.
  if (m.homeOverrideArgs !== undefined) {
    throw new Error(`provider ${file}: homeOverrideArgs is not supported for HTTP providers`);
  }
  if (m.envPassthrough !== undefined) {
    throw new Error(
      `provider ${file}: \`envPassthrough\` is not supported for HTTP providers`,
    );
  }
  if (m.dangerousArgs !== undefined) {
    throw new Error(
      `provider ${file}: \`dangerousArgs\` is not supported for HTTP providers`,
    );
  }
  if (m.egressAllowlist !== undefined) {
    throw new Error(
      `provider ${file}: \`egressAllowlist\` is not supported for HTTP providers`,
    );
  }
  return {
    ...common,
    transport: 'http',
    baseUrl: (m.baseUrl as string).replace(/\/+$/, ''),
    endpoint: m.endpoint as string,
    profilesEndpoint: m.profilesEndpoint as string | undefined,
    defaultProfile: m.defaultProfile as string | undefined,
    auth: validateHttpAuth(m.auth, file),
    headers: validateHttpHeaders(m.headers, file),
    requestOptions: validateRequestOptions(m.requestOptions, file),
    profiles: validateHttpProfiles(m.profiles, file),
  };
}

function validateManifest(parsed: unknown, file: string): ProviderManifest {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`provider ${file}: not a JSON object`);
  }
  const m = parsed as Record<string, unknown>;
  const transportRaw = m.transport ?? 'cli';
  if (transportRaw !== 'cli' && transportRaw !== 'http') {
    throw new Error(
      `provider ${file}: \`transport\` must be "cli" or "http"`,
    );
  }
  const transport = transportRaw as ProviderTransport;
  return transport === 'http'
    ? validateHttpManifest(m, file)
    : validateCliManifest(m, file);
}

/** Suffix that marks a user-managed local provider (gitignored). */
export const HERMES_LOCAL_SUFFIX = '.hermes.local.json';
/** Suffix for UI-managed, reusable OpenAI-compatible providers. */
export const OPENAI_LOCAL_SUFFIX = '.openai.local.json';

/** Convert a `<id>.hermes.local.json` filename to its provider id. */
export function hermesLocalIdFromFilename(entry: string): string | null {
  if (!entry.endsWith(HERMES_LOCAL_SUFFIX)) return null;
  const stem = entry.slice(0, -HERMES_LOCAL_SUFFIX.length);
  return stem.length > 0 ? stem : null;
}

export function openAiLocalIdFromFilename(entry: string): string | null {
  if (!entry.endsWith(OPENAI_LOCAL_SUFFIX)) return null;
  const stem = entry.slice(0, -OPENAI_LOCAL_SUFFIX.length);
  return stem.length > 0 ? stem : null;
}

/** Lowercased, dash-only slug for use as an id component (e.g. when
 * building `<stem>-<profile>` ids). Mirrors the slug used by the store,
 * minus the unique-id collision logic — duplicates within a single
 * connection are not expected. */
function slugForId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Expand a `<stem>.hermes.local.json` file (new shape:
 * `{ label, host, token, ports: [{ port, profile }] }`) into one HTTP
 * manifest per port. Each manifest is its own palette card, labeled by
 * the discovered profile so the user picks the model directly.
 *
 * Returns `[]` (with a warn) on any structural issue — never throws —
 * so a single malformed local file can't break the whole providers API.
 */
function expandHermesLocalFile(
  parsed: unknown,
  stem: string,
  file: string,
): HttpProviderManifest[] {
  if (!parsed || typeof parsed !== 'object') {
    log.warn('file is not a JSON object', { file });
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const label = isNonEmptyString(p.label) ? p.label : null;
  const host = isNonEmptyString(p.host) ? p.host : null;
  const token = isNonEmptyString(p.token) ? p.token : null;
  if (!label || !host || !token) {
    log.warn('missing required field(s): label, host, token', { file });
    return [];
  }
  const portsRaw = Array.isArray(p.ports) ? p.ports : [];
  const out: HttpProviderManifest[] = [];
  for (let i = 0; i < portsRaw.length; i++) {
    const entry = portsRaw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const port = e.port;
    const profile = e.profile;
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      log.warn('port entry is not a valid port', { file, index: i });
      continue;
    }
    if (typeof profile !== 'string' || profile.length === 0) {
      log.warn('port entry profile is empty', { file, index: i });
      continue;
    }
    const profileSlug = slugForId(profile);
    const id = profileSlug ? `${stem}-${profileSlug}` : `${stem}-${port}`;
    out.push({
      id,
      label: profile,
      description: `${host}:${port}`,
      glyph: '☿',
      transport: 'http',
      kind: 'hermes-local',
      connectionId: stem,
      connectionLabel: label,
      baseUrl: `${host}:${port}/v1`,
      endpoint: '/responses',
      profilesEndpoint: '/models',
      defaultProfile: profile,
      auth: { type: 'bearer', token },
    });
  }
  return out;
}

/** Expand a UI-managed OpenAI-compatible connection into one regular HTTP
 * manifest. The connection file contains secrets; it is only read on the
 * server and never serialized by the connection CRUD API. */
function expandOpenAiLocalFile(
  parsed: unknown,
  stem: string,
  file: string,
): HttpProviderManifest[] {
  if (!parsed || typeof parsed !== 'object') {
    log.warn('file is not a JSON object', { file });
    return [];
  }
  const raw = parsed as Record<string, unknown>;
  try {
    const validated = validateHttpManifest({
      id: stem,
      label: raw.label,
      description: raw.description ?? 'OpenAI-compatible provider',
      glyph: '◌',
      transport: 'http',
      baseUrl: raw.baseUrl,
      // UI-managed OpenAI providers created before the Responses-only
      // migration may still persist the old Chat Completions path. Treat that
      // legacy setting as the current default; committed manifests remain
      // explicit and receive a clear compatibility error at run time.
      endpoint: raw.endpoint === '/chat/completions' ? '/responses' : raw.endpoint ?? '/responses',
      ...(raw.profilesEndpoint === '' ? {} : {
        profilesEndpoint: raw.profilesEndpoint ?? '/models',
      }),
      ...(typeof raw.token === 'string' && raw.token.length > 0
        ? { auth: { type: 'bearer', token: raw.token } }
        : {}),
      headers: raw.headers,
      requestOptions: raw.requestOptions,
      profiles: raw.profiles,
      defaultProfile: raw.defaultProfile,
    }, file);
    return [{
      ...validated,
      kind: 'openai-local',
      connectionId: stem,
      connectionLabel: validated.label,
    }];
  } catch (err) {
    log.warn('invalid OpenAI-compatible connection', { file, err });
    return [];
  }
}

interface CacheEntry {
  builtinDir: string;
  connDir: string;
  manifests: ProviderManifest[];
}

let cache: CacheEntry | null = null;
let cacheEpoch = 0;
let beforeCachePublishForTest: (() => void | Promise<void>) | undefined;

async function readJsonDir(dir: string): Promise<{ entry: string; file: string; parsed: unknown }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // Sort for deterministic ordering: readdir is filesystem-order on Linux
  // (ext4 hash order), alphabetical on macOS. First-wins on duplicate ids
  // would otherwise depend on the host filesystem.
  entries.sort();
  const results: { entry: string; file: string; parsed: unknown }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      log.warn('could not read file', { file, err });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn('file is not valid JSON', { file, err });
      continue;
    }
    results.push({ entry, file, parsed });
  }
  return results;
}

/**
 * Load provider manifests from two locations:
 *   1. Built-in manifests from `INFLOOP_PROVIDERS_DIR` (or `./providers/`).
 *   2. User-managed Hermes connections from `connectionsDir()` (`~/.infinite-loop/connections/`).
 *
 * Cached for provider-list reads. `getProvider()` refreshes before resolving
 * an id so newly saved connection files are usable immediately. Malformed
 * JSON, invalid manifests, and id collisions are logged and skipped.
 * First-wins on duplicate ids.
 */
export async function loadProviders(): Promise<ProviderManifest[]> {
  const builtinDir = providersDir();
  const connDir = connectionsDir();
  if (cache && cache.builtinDir === builtinDir && cache.connDir === connDir) {
    return cache.manifests;
  }
  const loadEpoch = cacheEpoch;

  const manifests: ProviderManifest[] = [];
  const byId = new Map<string, ProviderManifest>();

  // 1. Built-in manifests from project providers/ dir.
  for (const { entry, parsed } of await readJsonDir(builtinDir)) {
    if (hermesLocalIdFromFilename(entry) !== null || openAiLocalIdFromFilename(entry) !== null) continue;
    let manifest: ProviderManifest;
    try {
      manifest = validateManifest(parsed, entry);
    } catch (err) {
      log.warn('invalid manifest', { file: entry, err });
      continue;
    }
    if (byId.has(manifest.id)) {
      log.warn('id collision; ignoring file', { id: manifest.id, file: entry });
      continue;
    }
    byId.set(manifest.id, manifest);
    manifests.push(manifest);
  }

  // 2. User-managed Hermes connections from ~/.infinite-loop/connections/.
  for (const { entry, parsed } of await readJsonDir(connDir)) {
    const hermesLocalId = hermesLocalIdFromFilename(entry);
    if (hermesLocalId === null) continue;
    const expanded = expandHermesLocalFile(parsed, hermesLocalId, entry);
    for (const manifest of expanded) {
      if (byId.has(manifest.id)) {
        log.warn('id collision; ignoring entry from file', {
          id: manifest.id,
          file: entry,
        });
        continue;
      }
      byId.set(manifest.id, manifest);
      manifests.push(manifest);
    }
  }

  // 3. User-managed OpenAI-compatible connections. Unlike Hermes, one
  // connection maps to one reusable provider; models are selected in nodes.
  for (const { entry, parsed } of await readJsonDir(connDir)) {
    const openAiLocalId = openAiLocalIdFromFilename(entry);
    if (openAiLocalId === null) continue;
    const expanded = expandOpenAiLocalFile(parsed, openAiLocalId, entry);
    for (const manifest of expanded) {
      if (byId.has(manifest.id)) {
        log.warn('id collision; ignoring entry from file', { id: manifest.id, file: entry });
        continue;
      }
      byId.set(manifest.id, manifest);
      manifests.push(manifest);
    }
  }

  manifests.sort((a, b) => a.label.localeCompare(b.label));
  if (beforeCachePublishForTest) await beforeCachePublishForTest();
  // An invalidation can happen while filesystem reads are in flight. Do not
  // let that older snapshot repopulate a cache cleared by a later write.
  if (cacheEpoch === loadEpoch) {
    cache = { builtinDir, connDir, manifests };
  }
  return manifests;
}

export async function getProvider(id: string): Promise<ProviderManifest | undefined> {
  // Connection CRUD invalidates this cache, but the executor can be running
  // from a module instance that did not observe that invalidation. Refreshing
  // lookup state here keeps newly saved providers usable without a restart.
  _resetProviderCache();
  return (await loadProviders()).find((manifest) => manifest.id === id);
}

/** Test/dev helper: drop the in-process cache so the next load re-reads disk. */
export function _resetProviderCache(): void {
  cache = null;
  cacheEpoch++;
}

/** Test helper: pause a load after its filesystem snapshot is complete. */
export function _setBeforeProviderCachePublishForTest(
  hook: (() => void | Promise<void>) | undefined,
): void {
  beforeCachePublishForTest = hook;
}
