import { afterEach, describe, expect, it } from 'bun:test';
import * as http from 'node:http';
import * as net from 'node:net';
import {
  hostAllowed,
  isBlockedAddress,
  startEgressProxy,
  type EgressProxy,
} from './egress-proxy';

describe('hostAllowed', () => {
  it('matches an exact hostname', () => {
    expect(hostAllowed('api.anthropic.com', ['api.anthropic.com'])).toBe(true);
    expect(hostAllowed('evil.com', ['api.anthropic.com'])).toBe(false);
  });

  it('is case-insensitive and tolerates a trailing dot', () => {
    expect(hostAllowed('API.Anthropic.COM', ['api.anthropic.com'])).toBe(true);
    expect(hostAllowed('api.anthropic.com.', ['api.anthropic.com'])).toBe(true);
    expect(hostAllowed('api.anthropic.com', ['API.ANTHROPIC.COM'])).toBe(true);
  });

  it('matches a leading-wildcard against any depth of subdomain', () => {
    expect(hostAllowed('api.anthropic.com', ['*.anthropic.com'])).toBe(true);
    expect(hostAllowed('a.b.anthropic.com', ['*.anthropic.com'])).toBe(true);
  });

  it('does not match the apex with a leading-wildcard', () => {
    expect(hostAllowed('anthropic.com', ['*.anthropic.com'])).toBe(false);
  });

  it('does not match a lookalike suffix', () => {
    expect(hostAllowed('evil-anthropic.com', ['*.anthropic.com'])).toBe(false);
    expect(hostAllowed('notanthropic.com', ['*.anthropic.com'])).toBe(false);
    expect(hostAllowed('anthropic.com.evil.com', ['*.anthropic.com'])).toBe(
      false,
    );
  });

  it('returns false for an empty host or empty allowlist', () => {
    expect(hostAllowed('', ['api.anthropic.com'])).toBe(false);
    expect(hostAllowed('api.anthropic.com', [])).toBe(false);
  });

  it('rejects a host carrying userinfo, a path, or whitespace', () => {
    // The target is attacker-controlled — the matcher must provably refuse
    // anything that is not a plain hostname, not rely on a downstream failure.
    expect(hostAllowed('api.anthropic.com@evil.com', ['*.anthropic.com'])).toBe(
      false,
    );
    expect(hostAllowed('api.anthropic.com/x', ['api.anthropic.com'])).toBe(
      false,
    );
    expect(hostAllowed('api.anthropic.com ', ['api.anthropic.com'])).toBe(true); // trimmed
    expect(hostAllowed('api anthropic.com', ['api anthropic.com'])).toBe(false);
  });
});

describe('isBlockedAddress', () => {
  it('blocks loopback, private, and link-local IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata endpoint
      '0.0.0.0',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('blocks loopback, ULA, and link-local IPv6', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedAddress('2606:4700::1111')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks anything that is not a valid IP literal', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('startEgressProxy', () => {
  const servers: (net.Server | http.Server)[] = [];
  const proxies: EgressProxy[] = [];

  afterEach(() => {
    for (const p of proxies) p.close();
    for (const s of servers) s.close();
    proxies.length = 0;
    servers.length = 0;
  });

  function portOf(srv: net.Server | http.Server): number {
    const a = srv.address();
    return a && typeof a === 'object' ? a.port : 0;
  }

  /** A TCP server that echoes back whatever it receives. */
  function startTcpEcho(): Promise<net.Server> {
    return new Promise((resolve) => {
      const srv = net.createServer((sock) => sock.pipe(sock));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
  }

  /** A plain-HTTP server that replies `200 hello`. */
  function startHttpHello(): Promise<http.Server> {
    return new Promise((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200).end('hello');
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
  }

  /** Open a raw TCP `CONNECT` against the proxy — exercises the same
   *  server-side path a real HTTPS client takes, without depending on the
   *  http client's CONNECT support. Resolves with the status and the still-open
   *  socket (the tunnel, when status is 200). */
  function rawConnect(
    proxy: EgressProxy,
    target: string,
  ): Promise<{ status: number; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const u = new URL(proxy.url);
      const socket = net.connect(Number(u.port), u.hostname, () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let buf = '';
      const onData = (d: Buffer): void => {
        buf += d.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);
        const m = /HTTP\/1\.\d (\d+)/.exec(buf.slice(0, buf.indexOf('\r\n')));
        resolve({ status: m ? Number(m[1]) : 0, socket });
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
  }

  /** Issue a plain-HTTP proxied request (absolute-form request target). */
  function httpThroughProxy(
    proxy: EgressProxy,
    absoluteUrl: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(proxy.url);
      const req = http.request(
        {
          host: u.hostname,
          port: Number(u.port),
          method: 'GET',
          path: absoluteUrl,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('tunnels a CONNECT to an allowlisted host', async () => {
    const echo = await startTcpEcho();
    servers.push(echo);
    const proxy = await startEgressProxy(['127.0.0.1']);
    proxies.push(proxy);

    const { status, socket } = await rawConnect(
      proxy,
      `127.0.0.1:${portOf(echo)}`,
    );
    expect(status).toBe(200);

    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (d: Buffer) => resolve(d.toString()));
      socket.write('ping');
    });
    expect(echoed).toBe('ping');
    expect(proxy.deniedCount).toBe(0);
    socket.destroy();
  });

  it('refuses a CONNECT to an off-allowlist host with 403', async () => {
    const echo = await startTcpEcho();
    servers.push(echo);
    const proxy = await startEgressProxy(['example.com']);
    proxies.push(proxy);

    const { status, socket } = await rawConnect(
      proxy,
      `127.0.0.1:${portOf(echo)}`,
    );
    expect(status).toBe(403);
    expect(proxy.deniedCount).toBe(1);
    socket.destroy();
  });

  it('forwards a plain-HTTP request to an allowlisted host', async () => {
    const upstream = await startHttpHello();
    servers.push(upstream);
    const proxy = await startEgressProxy(['127.0.0.1']);
    proxies.push(proxy);

    const { status, body } = await httpThroughProxy(
      proxy,
      `http://127.0.0.1:${portOf(upstream)}/`,
    );
    expect(status).toBe(200);
    expect(body).toBe('hello');
  });

  it('refuses a plain-HTTP request to an off-allowlist host with 403', async () => {
    const upstream = await startHttpHello();
    servers.push(upstream);
    const proxy = await startEgressProxy(['example.com']);
    proxies.push(proxy);

    const { status } = await httpThroughProxy(
      proxy,
      `http://127.0.0.1:${portOf(upstream)}/`,
    );
    expect(status).toBe(403);
    expect(proxy.deniedCount).toBe(1);
  });

  it('denies every host when the allowlist is empty', async () => {
    const echo = await startTcpEcho();
    servers.push(echo);
    const proxy = await startEgressProxy([]);
    proxies.push(proxy);

    const { status, socket } = await rawConnect(
      proxy,
      `127.0.0.1:${portOf(echo)}`,
    );
    expect(status).toBe(403);
    socket.destroy();
  });

  it('refuses an allowlisted NAME that resolves to a private address', async () => {
    // `localhost` is on the allowlist by name, but it resolves to a loopback
    // address that is NOT itself an allowlist entry — the DNS-rebinding / SSRF
    // guard must refuse it even though the name passed `hostAllowed`.
    const proxy = await startEgressProxy(['localhost']);
    proxies.push(proxy);

    const { status, socket } = await rawConnect(proxy, 'localhost:80');
    expect(status).toBe(403);
    expect(proxy.deniedCount).toBe(1);
    socket.destroy();
  });

  it('exposes proxy env overrides and is idempotent on close', async () => {
    const proxy = await startEgressProxy(['127.0.0.1']);
    proxies.push(proxy);

    const ov = proxy.childEnvOverrides();
    expect(ov.HTTP_PROXY).toBe(proxy.url);
    expect(ov.HTTPS_PROXY).toBe(proxy.url);
    expect(ov.http_proxy).toBe(proxy.url);
    expect(ov.https_proxy).toBe(proxy.url);
    expect(ov.ALL_PROXY).toBe('');
    expect(ov.NO_PROXY).toContain('127.0.0.1');

    proxy.close();
    proxy.close(); // idempotent — must not throw
  });
});
