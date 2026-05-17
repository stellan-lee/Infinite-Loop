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
  return {
    ...common,
    transport: 'cli',
    bin: m.bin as string,
    args: m.args as string[],
    outputFormat: m.outputFormat as string,
    promptVia: (m.promptVia as 'arg' | 'stdin' | undefined) ?? 'arg',
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
  return {
    ...common,
    transport: 'http',
    baseUrl: (m.baseUrl as string).replace(/\/+$/, ''),
    endpoint: m.endpoint as string,
    profilesEndpoint: m.profilesEndpoint as string | undefined,
    defaultProfile: m.defaultProfile as string | undefined,
    auth: validateHttpAuth(m.auth, file),
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

/** Convert a `<id>.hermes.local.json` filename to its provider id. */
export function hermesLocalIdFromFilename(entry: string): string | null {
  if (!entry.endsWith(HERMES_LOCAL_SUFFIX)) return null;
  const stem = entry.slice(0, -HERMES_LOCAL_SUFFIX.length);
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
    console.warn(`[providers] ${file} is not a JSON object`);
    return [];
  }
  const p = parsed as Record<string, unknown>;
  const label = isNonEmptyString(p.label) ? p.label : null;
  const host = isNonEmptyString(p.host) ? p.host : null;
  const token = isNonEmptyString(p.token) ? p.token : null;
  if (!label || !host || !token) {
    console.warn(
      `[providers] ${file}: missing required field(s) (label, host, token)`,
    );
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
      console.warn(`[providers] ${file}: ports[${i}].port is not a valid port`);
      continue;
    }
    if (typeof profile !== 'string' || profile.length === 0) {
      console.warn(`[providers] ${file}: ports[${i}].profile is empty`);
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
      endpoint: '/chat/completions',
      profilesEndpoint: '/models',
      defaultProfile: profile,
      auth: { type: 'bearer', token },
    });
  }
  return out;
}

interface CacheEntry {
  builtinDir: string;
  connDir: string;
  manifests: ProviderManifest[];
  byId: Map<string, ProviderManifest>;
}

let cache: CacheEntry | null = null;

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
      console.warn(`[providers] could not read ${file}: ${(err as Error).message}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[providers] ${file} is not valid JSON: ${(err as Error).message}`);
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
 * Cached for the process lifetime — restart or call `_resetProviderCache()`
 * to pick up new files. Malformed JSON, invalid manifests, and id collisions
 * are logged with `console.warn` and skipped. First-wins on duplicate ids.
 */
export async function loadProviders(): Promise<ProviderManifest[]> {
  const builtinDir = providersDir();
  const connDir = connectionsDir();
  if (cache && cache.builtinDir === builtinDir && cache.connDir === connDir) {
    return cache.manifests;
  }

  const manifests: ProviderManifest[] = [];
  const byId = new Map<string, ProviderManifest>();

  // 1. Built-in manifests from project providers/ dir.
  for (const { entry, parsed } of await readJsonDir(builtinDir)) {
    if (hermesLocalIdFromFilename(entry) !== null) continue;
    let manifest: ProviderManifest;
    try {
      manifest = validateManifest(parsed, entry);
    } catch (err) {
      console.warn(`[providers] ${(err as Error).message}`);
      continue;
    }
    if (byId.has(manifest.id)) {
      console.warn(
        `[providers] id collision: "${manifest.id}" already loaded; ignoring ${entry}`,
      );
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
        console.warn(
          `[providers] id collision: "${manifest.id}" already loaded; ignoring entry from ${entry}`,
        );
        continue;
      }
      byId.set(manifest.id, manifest);
      manifests.push(manifest);
    }
  }

  manifests.sort((a, b) => a.label.localeCompare(b.label));
  cache = { builtinDir, connDir, manifests, byId };
  return manifests;
}

export async function getProvider(id: string): Promise<ProviderManifest | undefined> {
  await loadProviders();
  return cache?.byId.get(id);
}

/** Test/dev helper: drop the in-process cache so the next load re-reads disk. */
export function _resetProviderCache(): void {
  cache = null;
}
