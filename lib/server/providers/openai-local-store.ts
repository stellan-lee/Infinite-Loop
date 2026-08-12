/*
 * Filesystem CRUD for reusable OpenAI-compatible providers. These are global
 * application settings rather than workflow data: credentials stay on the
 * server in 0600 connection files and read APIs only expose redacted metadata.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { connectionsDir } from '../paths';
import { _resetProviderCache, getProvider, OPENAI_LOCAL_SUFFIX } from './loader';
import type { HttpProviderProfile } from './types';

export interface OpenAiLocalConnection {
  id: string;
  label: string;
  baseUrl: string;
  endpoint: string;
  /** Empty means model discovery is disabled. */
  profilesEndpoint: string;
  profiles: HttpProviderProfile[];
  defaultProfile?: string;
  hasApiKey: boolean;
  headerNames: string[];
}

interface StoredConnection {
  label: string;
  baseUrl: string;
  endpoint: string;
  profilesEndpoint: string;
  profiles: HttpProviderProfile[];
  defaultProfile?: string;
  token?: string;
  headers?: Record<string, string>;
  requestOptions?: Record<string, unknown>;
}

export interface OpenAiLocalInput {
  label?: unknown;
  baseUrl?: unknown;
  endpoint?: unknown;
  profilesEndpoint?: unknown;
  profiles?: unknown;
  defaultProfile?: unknown;
  /** Omit / send an empty string on update to keep the saved API key. */
  apiKey?: unknown;
  /** Explicitly remove a saved API key. This is separate from an empty
   * write-only input, which intentionally means “keep existing”. */
  clearApiKey?: unknown;
  /** Values are write-only. On update, an empty value keeps an existing header
   * with the same name; send clearHeaders to explicitly remove it. */
  headers?: unknown;
  clearHeaders?: unknown;
  requestOptions?: unknown;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESPONSES_ENDPOINT = '/responses';
const LEGACY_CHAT_COMPLETIONS_ENDPOINT = '/chat/completions';
const PROTECTED_OPTIONS = new Set(['model', 'input', 'messages', 'stream', 'text', 'response_format', 'n']);
const SENSITIVE_OPTION_KEY_RE = /(?:^|[_-])(?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|credential(?:s)?|client[_-]?secret|headers?)(?:$|[_-])/i;

function fileFor(id: string): string {
  return path.join(connectionsDir(), `${id}${OPENAI_LOCAL_SUFFIX}`);
}

export function isValidOpenAiLocalId(id: string): boolean {
  return ID_RE.test(id);
}

function slugifyLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`\`${name}\` must be a non-empty string`);
  return value.trim();
}

function normalizeBaseUrl(value: unknown): string {
  const raw = nonEmpty(value, 'baseUrl');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('`baseUrl` must be a valid http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('`baseUrl` must use http:// or https://');
  if (url.username || url.password) throw new Error('`baseUrl` must not include credentials');
  if (url.search || url.hash) throw new Error('`baseUrl` must not include query or fragment');
  return raw.replace(/\/+$/, '');
}

function endpoint(value: unknown, name: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`\`${name}\` must be a string`);
  const result = value.trim();
  if (name === 'profilesEndpoint' && result === '') return '';
  if (!result.startsWith('/')) throw new Error(`\`${name}\` must start with "/"`);
  if (result.includes('?') || result.includes('#')) {
    throw new Error(`\`${name}\` must not include query or fragment`);
  }
  if (name === 'endpoint' && result === LEGACY_CHAT_COMPLETIONS_ENDPOINT) {
    // This is a safe in-memory migration for providers written before the
    // Responses-only transport. The next edit persists `/responses`.
    return RESPONSES_ENDPOINT;
  }
  if (name === 'endpoint' && result !== RESPONSES_ENDPOINT) {
    throw new Error('`endpoint` must be "/responses"; HTTP providers use the Responses API only');
  }
  return result;
}

function profiles(value: unknown): HttpProviderProfile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('`profiles` must be an array');
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`profiles[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    const id = nonEmpty(raw.id, `profiles[${index}].id`);
    if (seen.has(id)) throw new Error(`profile "${id}" is listed more than once`);
    seen.add(id);
    if (raw.label !== undefined && typeof raw.label !== 'string') throw new Error(`profiles[${index}].label must be a string`);
    return { id, ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}) };
  });
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return !!value && typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJson);
}

/** Request options are returned to the browser for editing, so credentials
 * must be rejected at every nesting level before they can be persisted. */
function isSensitiveRequestOptionKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SENSITIVE_OPTION_KEY_RE.test(normalized);
}

function requestOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJson(value)) throw new Error('`requestOptions` must be a JSON object');
  const out = value as Record<string, unknown>;
  const assertNoSecretKeys = (candidate: Record<string, unknown>, path = 'requestOptions'): void => {
    for (const [key, nested] of Object.entries(candidate)) {
      if (isSensitiveRequestOptionKey(key)) {
        throw new Error(`\`${path}.${key}\` may not contain credentials; use API key or custom headers instead`);
      }
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        assertNoSecretKeys(nested as Record<string, unknown>, `${path}.${key}`);
      }
      if (Array.isArray(nested)) {
        nested.forEach((entry, index) => {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            assertNoSecretKeys(entry as Record<string, unknown>, `${path}.${key}[${index}]`);
          }
        });
      }
    }
  };
  assertNoSecretKeys(out);
  for (const key of Object.keys(out)) {
    if (PROTECTED_OPTIONS.has(key)) throw new Error(`\`requestOptions.${key}\` is controlled by the OpenAI node`);
  }
  return out;
}

function headerValues(value: unknown, existing: Record<string, string>): Record<string, string> | undefined {
  if (value === undefined || value === null) return Object.keys(existing).length ? existing : undefined;
  if (!Array.isArray(value)) throw new Error('`headers` must be an array');
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== 'object') throw new Error(`headers[${i}] must be an object`);
    const row = item as Record<string, unknown>;
    const name = nonEmpty(row.name, `headers[${i}].name`);
    if (!HEADER_NAME_RE.test(name)) throw new Error(`headers[${i}].name is invalid`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`header "${name}" is listed more than once`);
    seen.add(key);
    if (typeof row.value !== 'string') throw new Error(`headers[${i}].value must be a string`);
    if (/[\r\n]/.test(row.value)) throw new Error(`headers[${i}].value must be a single-line string`);
    // Blank values during edits retain the old value, allowing the list API to
    // stay redacted. A blank value on create is rejected rather than stored.
    const oldName = Object.keys(existing).find((candidate) => candidate.toLowerCase() === key);
    const resolved = row.value === '' && oldName ? existing[oldName] : row.value;
    if (resolved === '') throw new Error(`headers[${i}].value must be non-empty`);
    out[name] = resolved;
  }
  return Object.keys(out).length ? out : undefined;
}

function publicConnection(id: string, stored: StoredConnection): OpenAiLocalConnection {
  return {
    id,
    label: stored.label,
    baseUrl: stored.baseUrl,
    endpoint: stored.endpoint,
    profilesEndpoint: stored.profilesEndpoint,
    profiles: stored.profiles,
    ...(stored.defaultProfile ? { defaultProfile: stored.defaultProfile } : {}),
    hasApiKey: typeof stored.token === 'string' && stored.token.length > 0,
    headerNames: Object.keys(stored.headers ?? {}),
  };
}

async function readStored(id: string): Promise<StoredConnection | null> {
  if (!isValidOpenAiLocalId(id)) return null;
  let raw: string;
  try { raw = await fs.readFile(fileFor(id), 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: StoredConnection = {
      label: nonEmpty(parsed.label, 'label'),
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      endpoint: endpoint(parsed.endpoint, 'endpoint', RESPONSES_ENDPOINT),
      profilesEndpoint: endpoint(parsed.profilesEndpoint, 'profilesEndpoint', '/models'),
      profiles: profiles(parsed.profiles),
      ...(typeof parsed.defaultProfile === 'string' && parsed.defaultProfile.trim() ? { defaultProfile: parsed.defaultProfile.trim() } : {}),
      ...(typeof parsed.token === 'string' && parsed.token ? { token: parsed.token } : {}),
      ...(parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers) ? { headers: parsed.headers as Record<string, string> } : {}),
      ...(parsed.requestOptions ? { requestOptions: requestOptions(parsed.requestOptions) } : {}),
    };
    return normalized;
  } catch { return null; }
}

async function writeStored(id: string, stored: StoredConnection): Promise<void> {
  const dir = connectionsDir();
  await fs.mkdir(dir, { recursive: true });
  const target = fileFor(id);
  const tmp = `${target}.tmp`;
  await fs.rm(tmp, { force: true });
  await fs.writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, target);
  _resetProviderCache();
}

async function idAvailable(id: string): Promise<boolean> {
  return !(await getProvider(id)) && !(await readStored(id));
}

async function uniqueId(label: string): Promise<string> {
  const base = slugifyLabel(label) || 'openai';
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 28)}-${n}`.slice(0, 30);
    if (isValidOpenAiLocalId(candidate) && await idAvailable(candidate)) return candidate;
  }
  throw new Error(`could not derive a unique id from label "${label}"`);
}

function normalizeInput(input: OpenAiLocalInput, existing?: StoredConnection): StoredConnection {
  const prior = existing ?? {
    label: '', baseUrl: '', endpoint: RESPONSES_ENDPOINT, profilesEndpoint: '/models', profiles: [],
  };
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
    throw new Error('`clearApiKey` must be a boolean');
  }
  const clearHeaders = Array.isArray(input.clearHeaders)
    ? new Set(input.clearHeaders.filter((name): name is string => typeof name === 'string').map((name) => name.toLowerCase()))
    : new Set<string>();
  const retainedHeaders = Object.fromEntries(Object.entries(prior.headers ?? {}).filter(([name]) => !clearHeaders.has(name.toLowerCase())));
  const nextHeaders = headerValues(input.headers, retainedHeaders);
  // Options can be arbitrary compatible-provider JSON. They are intentionally
  // write-only, like credentials: returning opaque values would make it
  // impossible to guarantee a provider-specific secret is never exposed.
  const nextRequestOptions = input.requestOptions === undefined
    ? prior.requestOptions
    : requestOptions(input.requestOptions);
  const next: StoredConnection = {
    label: nonEmpty(input.label, 'label'),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    endpoint: endpoint(input.endpoint, 'endpoint', RESPONSES_ENDPOINT),
    profilesEndpoint: endpoint(input.profilesEndpoint, 'profilesEndpoint', '/models'),
    profiles: profiles(input.profiles),
    ...(typeof input.defaultProfile === 'string' && input.defaultProfile.trim() ? { defaultProfile: input.defaultProfile.trim() } : {}),
    ...(apiKey ? { token: apiKey } : input.clearApiKey ? {} : prior.token ? { token: prior.token } : {}),
    ...(nextHeaders ? { headers: nextHeaders } : {}),
    ...(nextRequestOptions ? { requestOptions: nextRequestOptions } : {}),
  };
  return next;
}

export async function listOpenAiConnections(): Promise<OpenAiLocalConnection[]> {
  let entries: string[];
  try { entries = await fs.readdir(connectionsDir()); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: OpenAiLocalConnection[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(OPENAI_LOCAL_SUFFIX)) continue;
    const id = entry.slice(0, -OPENAI_LOCAL_SUFFIX.length);
    const stored = await readStored(id);
    if (stored) out.push(publicConnection(id, stored));
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export async function getOpenAiConnection(id: string): Promise<OpenAiLocalConnection | null> {
  const stored = await readStored(id);
  return stored ? publicConnection(id, stored) : null;
}

export async function createOpenAiConnection(id: string | null, input: OpenAiLocalInput): Promise<OpenAiLocalConnection> {
  const stored = normalizeInput(input);
  const resolvedId = id?.trim() || await uniqueId(stored.label);
  if (!isValidOpenAiLocalId(resolvedId)) throw new Error('id must match /^[a-z0-9][a-z0-9-]{0,29}$/');
  if (!(await idAvailable(resolvedId))) throw new Error(`a provider with id "${resolvedId}" already exists`);
  await writeStored(resolvedId, stored);
  return publicConnection(resolvedId, stored);
}

export async function updateOpenAiConnection(id: string, input: OpenAiLocalInput): Promise<OpenAiLocalConnection | null> {
  const existing = await readStored(id);
  if (!existing) return null;
  const stored = normalizeInput(input, existing);
  await writeStored(id, stored);
  return publicConnection(id, stored);
}

export async function deleteOpenAiConnection(id: string): Promise<boolean> {
  if (!isValidOpenAiLocalId(id)) return false;
  try { await fs.unlink(fileFor(id)); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  _resetProviderCache();
  return true;
}
