/*
 * Filesystem CRUD for user-managed Hermes connections — the
 * `<id>.hermes.local.json` files in `providers/`.
 *
 * A connection is one (host, token) pair plus a list of ports. Each port
 * runs a different model on a Hermes Agent–style server (see
 * https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server),
 * and at save time we hit `<host>:<port>/v1/models` to discover the
 * profile (model id) served there. The loader later expands one
 * connection into one palette card per (port, profile) pair.
 *
 * Writes always invalidate the loader's in-process cache so a new
 * connection shows up in the palette on the next `/api/providers` call.
 */

import { promises as fs } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { _resetProviderCache, getProvider, HERMES_LOCAL_SUFFIX } from './loader';
import { connectionsDir } from '../paths';

export interface PortProfile {
  port: number;
  /** Model id served at that port — discovered from `/v1/models`'s
   * `data[0].id` at save time. */
  profile: string;
}

export interface HermesLocalConnection {
  id: string;
  label: string;
  /** Scheme + hostname only — no port, no path. Per-port URLs are
   * constructed by the loader / runner as `<host>:<port>/v1`. */
  host: string;
  token: string;
  ports: PortProfile[];
}

/* All fields are `unknown` because input arrives from JSON; validation
 * lives in `validateInput`. Required-ness is enforced there rather than in
 * the type so route handlers can pass through arbitrary parsed bodies
 * without a stricter pre-narrowing cast. */
export interface HermesLocalInput {
  label?: unknown;
  host?: unknown;
  token?: unknown;
  /** Either an array of bare numbers (the modal sends this on create when
   * the user types ports without pre-discovered profiles) or an array of
   * `{port, profile?}` objects. Numbers / unknown-profile entries are
   * resolved at save time via `/v1/models`. */
  ports?: unknown;
}

/** Lowercase letters, digits, dash. Anchors to the full string so a
 * malicious id can't include path separators or hidden suffix tricks
 * like "../foo" or "evil.hermes". 30-char cap keeps filenames sane. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;

function fileFor(id: string): string {
  return path.join(connectionsDir(), `${id}${HERMES_LOCAL_SUFFIX}`);
}

export function isValidLocalId(id: string): boolean {
  return ID_RE.test(id);
}

function slugifyLabel(label: string): string {
  let s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 30) s = s.slice(0, 30).replace(/-+$/g, '');
  return s;
}

async function isIdTaken(id: string): Promise<boolean> {
  if (await getProvider(id)) return true;
  if (await readOne(id)) return true;
  return false;
}

async function deriveUniqueId(label: string): Promise<string> {
  const base = slugifyLabel(label) || 'hermes';
  if (!(await isIdTaken(base))) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base.slice(0, 28)}-${i}`.slice(0, 30);
    if (isValidLocalId(candidate) && !(await isIdTaken(candidate))) {
      return candidate;
    }
  }
  throw new Error(`could not derive a unique id from label "${label}"`);
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`\`${field}\` must be a non-empty string`);
  }
  return v;
}

/** Strip everything except scheme + hostname. We refuse to silently
 * accept a port or path in `host` because the per-port URLs are
 * constructed by suffixing — leaving a port or path in `host` would
 * produce nonsense like `https://h.com:443:8001/v1`. */
function normalizeHost(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('`host` must start with http:// or https://');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('`host` is not a valid URL');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('`host` must not include a path (e.g. /v1)');
  }
  // Drop any port the user pasted — ports are managed separately. We
  // keep the original scheme + hostname.
  return `${url.protocol}//${url.hostname}`;
}

/** Build the per-port API base URL the runner will hit. */
export function buildPortBaseUrl(host: string, port: number): string {
  return `${host}:${port}/v1`;
}

/** Cap on `/v1/models` response body. The endpoint returns a small JSON
 *  list of models; anything larger is almost certainly an attempt to use
 *  the discovery fetch as an SSRF bandwidth amplifier. */
const MODELS_RESPONSE_MAX_BYTES = 256 * 1024;

function ipIsPrivateOrLocal(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map((s) => Number(s));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
    if (a === 192 && b === 168) return true;           // 192.168/16
    if (a >= 224) return true;                         // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;        // unique-local
    if (lower.startsWith('ff')) return true;                                  // multicast
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped: re-check the IPv4 portion.
      const tail = lower.slice('::ffff:'.length);
      if (isIP(tail) === 4) return ipIsPrivateOrLocal(tail);
    }
    return false;
  }
  // Unknown / unparseable — treat as unsafe.
  return true;
}

/** Refuse to fetch URLs whose hostname resolves to a loopback, RFC1918,
 *  link-local, or other reserved address. This is the SSRF guard for the
 *  Hermes provider create/update flow, where the caller supplies `host`
 *  and we hit `<host>:<port>/v1/models` server-side.
 *
 *  Known residual gap: this guard does one DNS lookup, then `fetch`
 *  resolves the host again via its own resolver — an attacker who
 *  controls authoritative DNS can serve a public IP to our lookup and a
 *  private IP to the subsequent fetch (classic DNS rebinding). Closing
 *  this would require dialing by resolved IP with the SNI/Host preserved
 *  (or using a pinning resolver). Acceptable for current deployment
 *  model (single-tenant local app); revisit if the server moves to a
 *  shared-tenancy footprint. */
async function assertHostnameIsPublic(host: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error('`host` is not a valid URL');
  }
  const hostname = url.hostname;
  // Strip IPv6 brackets if `URL` left them on.
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Literal IP — check directly without DNS.
  if (isIP(bare)) {
    if (ipIsPrivateOrLocal(bare)) {
      throw new Error(`refusing to reach private/loopback address ${bare}`);
    }
    return;
  }

  // Hostname — resolve and reject if ANY answer is private/local. We use
  // `all: true` so split-horizon DNS can't bypass by returning a public
  // address on one query and a private one on the next.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dnsLookup(bare, { all: true });
  } catch (err) {
    throw new Error(`could not resolve host ${bare}: ${(err as Error).message}`);
  }
  if (addrs.length === 0) {
    throw new Error(`could not resolve host ${bare}`);
  }
  for (const a of addrs) {
    if (ipIsPrivateOrLocal(a.address)) {
      throw new Error(
        `refusing to reach private/loopback address ${a.address} (resolved from ${bare})`,
      );
    }
  }
}

/** Hit `<host>:<port>/v1/models` and return `data[0].id`. Throws with a
 * focused message on any failure — caller surfaces it as a 400. */
export async function discoverProfile(
  host: string,
  port: number,
  token: string,
): Promise<string> {
  const url = `${buildPortBaseUrl(host, port)}/models`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new Error(
      `could not reach ${url}: ${(err as Error).message}`,
    );
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}`);
  }
  let body: unknown;
  try {
    body = await readCappedJson(resp, MODELS_RESPONSE_MAX_BYTES);
  } catch (err) {
    throw new Error(`${url}: ${(err as Error).message}`);
  }
  // OpenAI shape: `{ object: "list", data: [{ id, ... }, ...] }`. We take
  // `data[0].id` — Hermes Agent serves one model per port, so the list
  // has a single entry, and even on a multi-model server the first entry
  // is a deterministic pick that the user can verify in the UI.
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${url} returned no models`);
  }
  const first = data[0] as { id?: unknown };
  if (typeof first?.id !== 'string' || first.id.length === 0) {
    throw new Error(`${url} data[0].id is not a string`);
  }
  return first.id;
}

/** Parse a port input — number or numeric string. Throws on out-of-range
 * or non-finite values. */
function asPortNumber(v: unknown, field: string): number {
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string' && v.trim().length > 0) {
    n = Number(v);
  } else {
    throw new Error(`${field} must be a port number`);
  }
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${field} must be an integer in 1..65535`);
  }
  return n;
}

/** Parse a `ports` input into a normalized list of (port, optional
 * profile-override) pairs. Discovery is performed by the caller in a
 * later step — this function is pure / synchronous. */
function parsePortsInput(
  raw: unknown,
): Array<{ port: number; profile?: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('`ports` must be an array');
  }
  const out: Array<{ port: number; profile?: string }> = [];
  const seen = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    let port: number;
    let profile: string | undefined;
    if (typeof entry === 'number' || typeof entry === 'string') {
      port = asPortNumber(entry, `ports[${i}]`);
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      port = asPortNumber(e.port, `ports[${i}].port`);
      if (typeof e.profile === 'string' && e.profile.length > 0) {
        profile = e.profile;
      }
    } else {
      throw new Error(`ports[${i}] must be a number or {port, profile?}`);
    }
    if (seen.has(port)) {
      throw new Error(`port ${port} listed more than once`);
    }
    seen.add(port);
    out.push({ port, profile });
  }
  return out;
}

/** Read `resp.body` up to `maxBytes`, parse as JSON. Refuses oversize
 *  bodies even if the server lies about Content-Length, by reading
 *  chunked and bailing when the cap is exceeded. */
async function readCappedJson(resp: Response, maxBytes: number): Promise<unknown> {
  const contentLength = resp.headers.get('content-length');
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`response too large (${n} bytes > ${maxBytes} cap)`);
    }
  }
  if (!resp.body) throw new Error('empty response body');
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`response too large (>${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch {
    throw new Error('response was not decodable as UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('did not return JSON');
  }
}

/** Pure shape validation; does NOT touch the network. */
export function validateInputSync(input: HermesLocalInput): {
  label: string;
  host: string;
  token: string;
  ports: Array<{ port: number; profile?: string }>;
} {
  const label = asNonEmptyString(input.label, 'label');
  const host = normalizeHost(asNonEmptyString(input.host, 'host'));
  const token = asNonEmptyString(input.token, 'token');
  const ports = parsePortsInput(input.ports);
  return { label, host, token, ports };
}

/** Full validation including profile discovery for any port whose
 * profile wasn't supplied by the caller. Network errors propagate as
 * Error so the route layer can return a 400 with the failed port. */
export async function validateInput(
  input: HermesLocalInput,
): Promise<{
  label: string;
  host: string;
  token: string;
  ports: PortProfile[];
}> {
  const synced = validateInputSync(input);
  // Guard ONCE per host before any port-discovery fetch — prevents an
  // authenticated caller from using the discovery flow as an SSRF vector
  // against the server's internal network.
  await assertHostnameIsPublic(synced.host);
  const resolved: PortProfile[] = [];
  for (const entry of synced.ports) {
    let profile = entry.profile;
    if (!profile) {
      try {
        profile = await discoverProfile(synced.host, entry.port, synced.token);
      } catch (err) {
        throw new Error(
          `port ${entry.port}: ${(err as Error).message}`,
        );
      }
    }
    resolved.push({ port: entry.port, profile });
  }
  return { ...synced, ports: resolved };
}

async function readOne(id: string): Promise<HermesLocalConnection | null> {
  if (!isValidLocalId(id)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(fileFor(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.label !== 'string' ||
    typeof p.host !== 'string' ||
    typeof p.token !== 'string'
  ) {
    return null;
  }
  // Be tolerant of malformed `ports` rather than dropping the whole file
  // — a corrupted port entry just disappears from the list, the rest of
  // the connection stays editable.
  const portsRaw = Array.isArray(p.ports) ? p.ports : [];
  const ports: PortProfile[] = [];
  for (const entry of portsRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.port !== 'number' || typeof e.profile !== 'string') continue;
    ports.push({ port: e.port, profile: e.profile });
  }
  return {
    id,
    label: p.label,
    host: p.host,
    token: p.token,
    ports,
  };
}

export async function listConnections(): Promise<HermesLocalConnection[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(connectionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: HermesLocalConnection[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(HERMES_LOCAL_SUFFIX)) continue;
    const id = entry.slice(0, -HERMES_LOCAL_SUFFIX.length);
    if (!isValidLocalId(id)) continue;
    const conn = await readOne(id);
    if (conn) out.push(conn);
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export async function getConnection(
  id: string,
): Promise<HermesLocalConnection | null> {
  return readOne(id);
}

async function writeConnection(
  id: string,
  conn: Omit<HermesLocalConnection, 'id'>,
): Promise<void> {
  const dir = connectionsDir();
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    label: conn.label,
    host: conn.host,
    token: conn.token,
    ports: conn.ports,
  };
  await fs.writeFile(fileFor(id), JSON.stringify(payload, null, 2) + '\n', {
    mode: 0o600,
  });
  _resetProviderCache();
}

export async function createConnection(
  id: string | null,
  input: HermesLocalInput,
): Promise<HermesLocalConnection> {
  const validated = await validateInput(input);
  let resolvedId: string;
  if (id && id.length > 0) {
    if (!isValidLocalId(id)) {
      throw new Error('id must match /^[a-z0-9][a-z0-9-]{0,29}$/');
    }
    if (await isIdTaken(id)) {
      throw new Error(`a connection with id "${id}" already exists`);
    }
    resolvedId = id;
  } else {
    resolvedId = await deriveUniqueId(validated.label);
  }
  await writeConnection(resolvedId, validated);
  return { id: resolvedId, ...validated };
}

export async function updateConnection(
  id: string,
  input: HermesLocalInput,
): Promise<HermesLocalConnection | null> {
  if (!isValidLocalId(id)) return null;
  const existing = await readOne(id);
  if (!existing) return null;
  const validated = await validateInput(input);
  await writeConnection(id, validated);
  return { id, ...validated };
}

export async function deleteConnection(id: string): Promise<boolean> {
  if (!isValidLocalId(id)) return false;
  try {
    await fs.unlink(fileFor(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  _resetProviderCache();
  return true;
}
