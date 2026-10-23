/** Real TLS regression: an error is insufficient if HTTP credentials were already sent. */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { sendWebhookRequest } from './webhook-transport';

test.skipIf(!Bun.which('openssl'))('native TLS verifies identity before sending any HTTP bytes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'webhook-tls-'));
  const key = path.join(directory, 'fixture-key.pem'), cert = path.join(directory, 'fixture-cert.pem');
  const generated = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=webhook-fixture.test', '-addext', 'subjectAltName=DNS:webhook-fixture.test'], { stdout: 'pipe', stderr: 'pipe' });
  expect(generated.exitCode).toBe(0);
  const certificate = readFileSync(cert);
  const received: Array<{ path?: string; host?: string; authorization?: string }> = [];
  const server = https.createServer({ key: readFileSync(key), cert: certificate }, (request, response) => {
    received.push({ path: request.url, host: request.headers.host, authorization: request.headers.authorization });
    if (request.url === '/large') response.end('x'.repeat(70_000));
    else if (request.url === '/redirect') { response.writeHead(302, { location: 'https://webhook-fixture.test/target' }); response.end(); }
    else { response.setHeader('set-cookie', 'must-not-be-returned'); response.end('{"ok":true}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const dns4 = spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['93.184.216.34'] as never);
  const dns6 = spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([] as never);
  const nativeRequest = https.request;
  let trust = true;
  const requestSpy = spyOn(https, 'request').mockImplementation(((options: https.RequestOptions) => {
    expect(options.hostname).toBe('93.184.216.34');
    expect(options.rejectUnauthorized).toBe(true); expect(options.agent).toBe(false);
    expect(options.checkServerIdentity).toBeUndefined();
    // Test-only socket routing: production still chose a validated public address.
    return nativeRequest({ ...options, hostname: '127.0.0.1', ...(trust ? { ca: certificate } : {}) });
  }) as never);
  const send = (host: string, pathname: string) => sendWebhookRequest(new URL(`https://${host}:${port}${pathname}`), 'POST', { authorization: 'Bearer synthetic-tls-fixture' }, '{}', new AbortController().signal);
  try {
    expect((await send('webhook-fixture.test', '/ok')).statusCode).toBe(200);
    expect(received).toHaveLength(1); expect(received[0].host).toBe(`webhook-fixture.test:${port}`);
    await expect(send('wrong-fixture.test', '/wrong-host')).rejects.toThrow('network');
    expect(received).toHaveLength(1);
    trust = false;
    await expect(send('webhook-fixture.test', '/untrusted')).rejects.toThrow('network');
    expect(received).toHaveLength(1);
    trust = true;
    const redirect = await send('webhook-fixture.test', '/redirect');
    expect(redirect.statusCode).toBe(302); expect(received).toHaveLength(2);
    const large = await send('webhook-fixture.test', '/large');
    expect(large.truncated).toBe(true); expect(large.body).toBe('');
    expect((await send('webhook-fixture.test', '/ok')).headers).not.toHaveProperty('set-cookie');
  } finally {
    requestSpy.mockRestore(); dns4.mockRestore(); dns6.mockRestore();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
