import { afterEach, expect, spyOn, test } from 'bun:test';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { isPublicWebhookIP, resolveWebhookAddress, sendWebhookRequest, webhookSlots } from './webhook-transport';
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { spies.splice(0).forEach(spy => spy.mockRestore()); });
function dns(a: string[], aaaa: string[] = []) {
  spies.push(spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(a as never));
  spies.push(spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(aaaa as never));
}
test('rejects nonpublic and disguised IPv4/IPv6 destinations', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '168.63.129.16', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::', '2001::1', '3fff::1']) expect(isPublicWebhookIP(ip)).toBe(false);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicWebhookIP(ip)).toBe(true);
});
test('validates every DNS answer and normalized numeric IP URL', async () => {
  dns(['93.184.216.34', '127.0.0.1']);
  await expect(resolveWebhookAddress(new URL('https://example.com'), new AbortController().signal)).rejects.toThrow('unsafe_destination');
  for (const url of ['https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1', 'https://[::ffff:7f00:1]']) await expect(resolveWebhookAddress(new URL(url), new AbortController().signal)).rejects.toThrow('unsafe_destination');
});
test('rejects mixed public IPv4 / private IPv6 DNS', async () => {
  dns(['93.184.216.34'], ['::1']);
  await expect(resolveWebhookAddress(new URL('https://example.com'), new AbortController().signal)).rejects.toThrow('unsafe_destination');
});
test('pins the validated socket address and never follows redirects', async () => {
  dns(['93.184.216.34']);
  let options: https.RequestOptions | undefined;
  let requests = 0;
  spies.push(spyOn(https, 'request').mockImplementation(((opts: https.RequestOptions) => {
    options = opts; requests++;
    const request = new EventEmitter() as EventEmitter & { destroy(): void; end(): void };
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: 'http://127.0.0.1/secret' }, destroy() {} });
      request.emit('response', response);
    });
    return request;
  }) as never));
  const result = await sendWebhookRequest(new URL('https://example.com:8443/send?a=1'), 'POST', { authorization: 'Bearer fixture' }, '{}', new AbortController().signal);
  expect(result.statusCode).toBe(302); expect(result.headers).toEqual({}); expect(requests).toBe(1);
  expect(options?.hostname).toBe('93.184.216.34'); expect(options?.servername).toBe('example.com');
  expect(options?.headers).toMatchObject({ host: 'example.com:8443' });
  expect(options?.rejectUnauthorized).toBe(true); expect(options?.agent).toBe(false); expect(options?.path).toBe('/send?a=1');
});
test('bounded queue rejects saturation and cancelled waiters are removed', async () => {
  const releases = await Promise.all(Array.from({ length: 8 }, () => webhookSlots.acquire(new AbortController().signal)));
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const queued = controllers.map(controller => webhookSlots.acquire(controller.signal).catch(error => error));
  await expect(webhookSlots.acquire(new AbortController().signal)).rejects.toThrow('queue_full');
  controllers.forEach(controller => controller.abort());
  expect((await Promise.all(queued)).every(value => value instanceof Error)).toBe(true);
  releases.forEach(release => release());
  const release = await webhookSlots.acquire(new AbortController().signal); release();
});
