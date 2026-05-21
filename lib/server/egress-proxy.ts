/*
 * Per-run egress filtering proxy.
 *
 * An Agent node spawns a provider CLI that runs untrusted, prompt-shaped code
 * with a real API credential in its environment (the manifest's
 * `envPassthrough` — e.g. `ANTHROPIC_*` — which scrubbing cannot strip without
 * breaking the provider). Nothing otherwise stops that code from POSTing the
 * credential to an arbitrary host.
 *
 * When the operator opts into enforcement (`INFLOOP_EGRESS_ENFORCE=1`) and a
 * provider manifest declares an `egressAllowlist`, the runner starts one of
 * these proxies per run, binds it to loopback, and points the child's
 * `HTTP(S)_PROXY` at it. The proxy permits CONNECT tunnels and plain-HTTP
 * forwards only to allowlisted hosts and refuses everything else with `403`.
 *
 * Two layers of host enforcement:
 *   1. NAME — the requested host must match the allowlist (`hostAllowed`).
 *   2. ADDRESS — the host is resolved here and the connection is dialed at the
 *      resolved IP, which must not be loopback/private/link-local (unless that
 *      exact IP literal is itself an allowlist entry). This closes DNS
 *      rebinding and stops the proxy being an SSRF pivot to internal services
 *      or a cloud metadata endpoint.
 *
 * Scope and limits — this is defense-in-depth, not a jail:
 *   - It catches every standard HTTP client that honours `HTTP(S)_PROXY`
 *     (curl, wget, the provider CLIs, Python `requests`, …). Raw-socket code
 *     that ignores the proxy env vars bypasses it.
 *   - It does not stop exfiltration to an *allowlisted* host. The allowlist
 *     removes the arbitrary-endpoint channel; it does not seal every channel.
 *
 * The host-matching logic (`hostAllowed`) and the address guard
 * (`isBlockedAddress`) are pure and exported so they are unit tested
 * independently of the proxy's network I/O.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createLogger } from './logger';

const log = createLogger('egress');

/** The proxy only ever binds loopback — it exists for this host's children. */
const PROXY_HOST = '127.0.0.1';

/** Loopback bypass list handed to the child so it can still reach a local
 *  service (e.g. the injected SetOutput MCP server) without the proxy. */
const NO_PROXY_VALUE = 'localhost,127.0.0.1,::1';

/** A running per-run egress proxy. Created by {@link startEgressProxy}. */
export interface EgressProxy {
  /** Proxy base URL, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Env vars that route a spawned child's HTTP(S) traffic through this proxy.
   *  Fed to `buildChildEnv`'s `overrides` so they win over any inherited
   *  host proxy config. */
  childEnvOverrides(): Record<string, string>;
  /** Count of connection attempts refused — off-allowlist host, or a host
   *  that resolved to a blocked address. */
  readonly deniedCount: number;
  /** Stop accepting and destroy every in-flight socket. Idempotent. */
  close(): void;
}

/** Normalize a request host for matching: trim, lowercase, drop a trailing
 *  dot, and unwrap an `[ipv6]` literal. Returns `''` for anything that is not
 *  a plausible hostname / IP literal — a userinfo `@`, a path, whitespace —
 *  so the matcher provably refuses a malformed target instead of relying on a
 *  downstream resolution failure. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length === 0 || !/^[a-z0-9.:-]+$/.test(h)) return '';
  return h;
}

/**
 * True when `host` is permitted by `allowlist`. An allowlist entry is either an
 * exact hostname or a leading-wildcard `*.suffix` that matches any subdomain
 * but NOT the apex (`*.anthropic.com` matches `api.anthropic.com`, not
 * `anthropic.com` — DNS wildcard semantics). Case-insensitive; the loader also
 * lowercases entries, but this lowercases defensively for direct callers.
 *
 * Pure — exported for unit testing.
 */
export function hostAllowed(
  host: string,
  allowlist: readonly string[],
): boolean {
  const h = normalizeHost(host);
  if (h.length === 0) return false;
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".anthropic.com"
      // `length >` (not `>=`) requires at least one label before the dot, so
      // the apex itself is excluded.
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

/**
 * True for an address the proxy must not dial: loopback, RFC1918 private,
 * link-local (incl. the `169.254.169.254` cloud metadata endpoint), IPv6
 * unique-local / link-local, and anything that is not a valid IP literal.
 *
 * Pure — exported for unit testing.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    return false;
  }
  if (version === 6) {
    const h = ip.toLowerCase();
    if (h === '::1' || h === '::') return true; // loopback, unspecified
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true; // not a valid IP — fail closed
}

/** Split a `host:port` (or bare `host`) target, unwrapping an IPv6 literal.
 *  An absent or unparseable port falls back to `defaultPort`. Note: an
 *  *unbracketed* IPv6 literal cannot be parsed unambiguously and will
 *  mis-split — that is acceptable, the mis-parsed host simply fails the
 *  allowlist check (fails closed). Real clients bracket IPv6 in CONNECT. */
function splitHostPort(
  target: string,
  defaultPort: number,
): { host: string; port: number } {
  const toPort = (s: string): number => {
    const n = Number(s);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : defaultPort;
  };
  if (target.startsWith('[')) {
    const end = target.indexOf(']');
    if (end !== -1) {
      const host = target.slice(1, end);
      const rest = target.slice(end + 1);
      return {
        host,
        port: rest.startsWith(':') ? toPort(rest.slice(1)) : defaultPort,
      };
    }
  }
  const colon = target.lastIndexOf(':');
  if (colon === -1) return { host: target, port: defaultPort };
  return { host: target.slice(0, colon), port: toPort(target.slice(colon + 1)) };
}

/**
 * Resolve `host` to a single IP and confirm it is safe to dial. Returns the IP
 * to connect to, or `null` when the host is unresolvable or resolves to a
 * blocked address (the DNS-rebinding / SSRF guard). An IP literal that the
 * operator placed on the allowlist verbatim is dialed as-is even if it is in a
 * blocked range — that is an explicit operator choice (e.g. an allowlisted
 * `127.0.0.1` test/loopback endpoint).
 */
async function safeDialTarget(
  host: string,
  allowlist: readonly string[],
): Promise<string | null> {
  let ip: string;
  if (isIP(host) !== 0) {
    ip = host;
  } else {
    try {
      ip = (await lookup(host)).address;
    } catch {
      return null;
    }
  }
  if (isBlockedAddress(ip)) {
    const explicit = allowlist.some(
      (e) => e.trim().toLowerCase() === ip.toLowerCase(),
    );
    if (!explicit) return null;
  }
  return ip;
}

/**
 * Start a per-run egress proxy enforcing `allowlist`, bound to a loopback port
 * the OS assigns. Resolves once the listener is up; rejects if it cannot bind
 * (the runner treats that as fail-closed — the run fails rather than running
 * with unrestricted egress).
 */
export function startEgressProxy(
  allowlist: readonly string[],
): Promise<EgressProxy> {
  return new Promise<EgressProxy>((resolve, reject) => {
    let deniedCount = 0;
    let closed = false;
    let listening = false;
    // Every socket touching the proxy — inbound client connections and the
    // outbound upstream sockets of both CONNECT tunnels and plain-HTTP
    // forwards. Destroyed on close() so a hung connection cannot outlive the
    // run.
    const sockets = new Set<Socket>();

    const track = (s: Socket): void => {
      sockets.add(s);
      s.once('close', () => sockets.delete(s));
    };

    const deny = (host: string, reason: string): void => {
      deniedCount++;
      log.warn('blocked egress', { host, reason });
    };

    const server = http.createServer();

    // Inbound connections (plain-HTTP requests and the client side of a
    // CONNECT tunnel both arrive as server connections).
    server.on('connection', track);

    // CONNECT — HTTPS tunnelling, the dominant case.
    server.on('connect', (req, clientSocket: Socket, head: Buffer) => {
      const { host, port } = splitHostPort(req.url ?? '', 443);
      const refuse = (): void => {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        clientSocket.end();
      };
      if (!hostAllowed(host, allowlist)) {
        deny(host, 'off-allowlist');
        refuse();
        return;
      }
      void (async () => {
        const dialIp = await safeDialTarget(normalizeHost(host), allowlist);
        if (dialIp === null) {
          deny(host, 'blocked-address');
          refuse();
          return;
        }
        if (clientSocket.destroyed) return;
        const upstream = net.connect(port, dialIp);
        track(upstream);
        upstream.on('connect', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      })().catch((err) => {
        log.warn('egress proxy CONNECT handler error', { err: String(err) });
        clientSocket.destroy();
      });
    });

    // Plain-HTTP proxied requests — absolute-form URL (`http://host/path`).
    server.on('request', (req, res) => {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (target.protocol !== 'http:') {
        // HTTPS arrives as CONNECT; a non-http scheme here is malformed.
        res.writeHead(400).end();
        return;
      }
      if (!hostAllowed(target.hostname, allowlist)) {
        deny(target.hostname, 'off-allowlist');
        res.writeHead(403).end();
        return;
      }
      void (async () => {
        const dialIp = await safeDialTarget(
          normalizeHost(target.hostname),
          allowlist,
        );
        if (dialIp === null) {
          deny(target.hostname, 'blocked-address');
          if (!res.headersSent) res.writeHead(403);
          res.end();
          return;
        }
        // Dial the resolved IP; the original `Host` header (carried in
        // `req.headers`) keeps upstream virtual-hosting correct.
        const upstreamReq = http.request(
          {
            host: dialIp,
            port: target.port || 80,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers: req.headers,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        // Track the outbound socket so close() tears it down too.
        upstreamReq.on('socket', track);
        upstreamReq.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(upstreamReq);
      })().catch((err) => {
        log.warn('egress proxy request handler error', { err: String(err) });
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });

    // An http.Server with no 'error' listener THROWS on error and would crash
    // the orchestrator. Before listen, a bind failure rejects the start
    // Promise; after, errors are logged and the affected request just fails.
    server.on('error', (err) => {
      if (!listening) {
        log.warn('egress proxy failed to start', {
          err: (err as Error).message,
        });
        reject(err);
        return;
      }
      log.warn('egress proxy server error', { err: (err as Error).message });
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      server.close();
      for (const s of sockets) s.destroy();
      sockets.clear();
    };

    server.listen(0, PROXY_HOST, () => {
      listening = true;
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const url = `http://${PROXY_HOST}:${port}`;
      log.debug('egress proxy listening', { url, allowlist });
      resolve({
        url,
        childEnvOverrides: () => ({
          HTTP_PROXY: url,
          HTTPS_PROXY: url,
          http_proxy: url,
          https_proxy: url,
          // Neutralise an inherited SOCKS/all-proxy so traffic cannot route
          // around the filter.
          ALL_PROXY: '',
          all_proxy: '',
          NO_PROXY: NO_PROXY_VALUE,
          no_proxy: NO_PROXY_VALUE,
        }),
        get deniedCount() {
          return deniedCount;
        },
        close,
      });
    });
  });
}
