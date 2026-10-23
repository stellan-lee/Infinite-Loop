import { expect, test } from 'bun:test';
import { validateSendWebhookConfig, webhookDestination, type SendWebhookConfig } from './send-webhook';
const base: SendWebhookConfig = { url: 'https://example.com/webhook', method: 'POST', body: '{}' };
test('accepts JSON templates, methods, server auth references and bounded settings', () => {
  expect(() => validateSendWebhookConfig({ ...base, body: '{"message":"{{agent.stdout}}"}', auth: { type: 'bearer', secretRef: 'PARTNER_TOKEN' }, maxAttempts: 3, idempotencyKey: '{{inputs.key}}' })).not.toThrow();
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) expect(() => validateSendWebhookConfig({ ...base, method, body: '' })).not.toThrow();
});
test('rejects credentials, control headers, invalid JSON and unbounded settings', () => {
  for (const patch of [
    { url: 'http://example.com' }, { url: 'https://user:password@example.com' }, { url: 'https://example.com?access_token=x' },
    { headers: { Authorization: 'Bearer plain' } }, { headers: { 'X-API-Key': 'plain' } }, { headers: { Cookie: 'session=x' } },
    { headers: { Host: 'evil.test' } }, { headers: { 'X-Test': 'a\r\nb' } }, { headers: { A: 'a', a: 'b' } },
    { body: '{"value":{{upstream.stdout}}}' }, { method: 'GET' }, { timeoutMs: 0 }, { timeoutMs: 60001 },
    { maxAttempts: 4 }, { maxAttempts: 2 }, { retryDelayMs: 5001 }, { successStatuses: [302] },
    { auth: { type: 'bearer', secretRef: 'PATH' }, url: 'https://{{inputs.host}}/send' },
    { auth: { type: 'header', secretRef: 'TOKEN', header: 'Host' } },
    { auth: { type: 'bearer', secretRef: '../TOKEN' } },
  ]) expect(() => validateSendWebhookConfig({ ...base, ...patch })).toThrow();
});
test('safe destinations never include userinfo, path, query or templated authority', () => {
  expect(webhookDestination('https://example.com/token-secret?key=hidden')).toBe('https://example.com');
  expect(webhookDestination('https://user:pass@example.com')).toBe('HTTPS endpoint');
  expect(webhookDestination('https://{{inputs.host}}/path')).toBe('HTTPS endpoint');
});
