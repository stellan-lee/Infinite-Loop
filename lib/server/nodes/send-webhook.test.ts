import { afterEach, expect, spyOn, test } from 'bun:test';
import * as transport from '../webhook-transport';
import { CheckpointError } from '../durable-run';
import { sendWebhookExecutor, redactWebhookText } from './send-webhook';
import type { NodeExecutorContext } from '../../shared/workflow';
import type { SendWebhookConfig, SendWebhookOutput } from '../../shared/send-webhook';
const base: SendWebhookConfig = { url: 'https://example.com/webhook', method: 'POST', body: '{"message":"{{agent.stdout}}"}' };
const context = (config = base): NodeExecutorContext => ({ config, scope: { agent: { stdout: 'hello "world"\n{{not-a-template}}' } }, defaultCwd: '/tmp', signal: new AbortController().signal });
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { spies.splice(0).forEach(spy => spy.mockRestore()); delete process.env.INFLOOP_WEBHOOK_SECRET_TEST_FIXTURE; });
function response(statusCode = 200, body = '{"ok":true}') {
  const spy = spyOn(transport, 'sendWebhookRequest').mockResolvedValue({ statusCode, body, headers: { 'content-type': 'application/json' }, truncated: false }); spies.push(spy); return spy;
}
test('parses JSON before interpolation and publishes progress before delivery', async () => {
  const request = response(); const ctx = context(); const progress: SendWebhookOutput[] = [];
  ctx.reportWebhookProgress = output => { progress.push(output); if (output.attempts.length === 1 && output.attempts[0].statusCode === undefined) expect(request).not.toHaveBeenCalled(); };
  const result = await sendWebhookExecutor.execute(ctx);
  expect(JSON.parse(request.mock.calls[0][3]!)).toEqual({ message: ctx.scope.agent.stdout });
  expect(result.branch).toBe('success'); expect(result.outputs.status).toBe('SUCCEEDED'); expect(progress.length).toBeGreaterThan(2);
});
test('only dedicated environment references are used and all credential echoes are redacted', async () => {
  const secret = 'synthetic-fixture-secret'; process.env.INFLOOP_WEBHOOK_SECRET_TEST_FIXTURE = secret;
  const request = response(201, JSON.stringify({ echo: secret, encoded: Buffer.from(secret).toString('base64'), token: 'receiver-token', nested: { password: 'receiver-password' } }));
  const result = await sendWebhookExecutor.execute(context({ ...base, auth: { type: 'bearer', secretRef: 'TEST_FIXTURE' } }));
  expect(request.mock.calls[0][2].authorization).toBe(`Bearer ${secret}`);
  const output = JSON.stringify(result); expect(output).not.toContain(secret); expect(output).not.toContain('receiver-token'); expect(output).not.toContain('receiver-password');
});
test('JSON key redaction precedes secret replacement including URL path named token', () => {
  expect(redactWebhookText('{"token":"receiver-secret","password":"hidden"}', ['token', 'password'])).not.toContain('receiver-secret');
  expect(redactWebhookText('token=receiver-secret', ['token'])).not.toContain('receiver-secret');
});
test('rejects dynamic authenticated origins, missing refs and sensitive URL query without sending', async () => {
  const request = response();
  for (const config of [{ ...base, url: 'https://{{agent.stdout}}/send', auth: { type: 'bearer' as const, secretRef: 'TEST_FIXTURE' } }, { ...base, body: '{"x":"{{absent.value}}"}' }, { ...base, url: 'https://example.com?token=private' }, { ...base, auth: { type: 'bearer' as const, secretRef: 'PATH' } }]) {
    expect((await sendWebhookExecutor.execute(context(config))).branch).toBe('failure');
  }
  expect(request).not.toHaveBeenCalled();
});
test('retries transient HTTP failures with stable key and observable attempts', async () => {
  const request = response(503);
  const ctx = context({ ...base, maxAttempts: 3, retryDelayMs: 0, idempotencyKey: 'event-1' });
  const result = await sendWebhookExecutor.execute(ctx);
  expect(request).toHaveBeenCalledTimes(3); expect(result.outputs.attempts).toHaveLength(3); expect(result.branch).toBe('failure');
  expect(request.mock.calls.every(call => call[2]['idempotency-key'] === 'event-1')).toBe(true);
});
test('does not retry redirect or rejected ordinary HTTP status and accepts configured status', async () => {
  const request = response(302);
  expect((await sendWebhookExecutor.execute(context({ ...base, maxAttempts: 3, retryDelayMs: 0, idempotencyKey: 'event' }))).outputs.errorCategory).toBe('redirect');
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue({ statusCode: 409, body: 'already exists', headers: {}, truncated: false });
  expect((await sendWebhookExecutor.execute(context({ ...base, successStatuses: [409] }))).branch).toBe('success');
});
test('overall deadline and cancellation stop the transport and retries', async () => {
  const request = response(); request.mockImplementation(async (_url, _method, _headers, _body, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })));
  const timed = await sendWebhookExecutor.execute(context({ ...base, timeoutMs: 100 })); expect(timed.outputs.errorCategory).toBe('timeout');
  const controller = new AbortController(); const ctx = context(); ctx.signal = controller.signal;
  const pending = sendWebhookExecutor.execute(ctx); setTimeout(() => controller.abort(), 10);
  expect((await pending).outputs.status).toBe('CANCELLED'); expect(request).toHaveBeenCalledTimes(2);
});
test('checkpoint error escapes before side effect and abort does not send', async () => {
  const request = response(); const ctx = context(); ctx.reportWebhookProgress = () => { throw new CheckpointError('fixture checkpoint'); };
  await expect(sendWebhookExecutor.execute(ctx)).rejects.toThrow(CheckpointError); expect(request).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort(); const cancelled = context(); cancelled.signal = controller.signal;
  expect((await sendWebhookExecutor.execute(cancelled)).outputs.status).toBe('CANCELLED'); expect(request).not.toHaveBeenCalled();
});
test('expanded request and response redaction remain bounded', async () => {
  const request = response(200, 'a'.repeat(65000));
  const ctx = context({ ...base, url: 'https://example.com/a' });
  const result = await sendWebhookExecutor.execute(ctx);
  expect(result.outputs.responseTruncated).toBe(true); expect(result.outputs.responseBody).toBe('');
  const large = context(); large.scope.agent.stdout = 'x'.repeat(66000);
  expect((await sendWebhookExecutor.execute(large)).outputs.errorCategory).toBe('request_limit'); expect(request).toHaveBeenCalledTimes(1);
});

test('duplicate short secrets and marker characters never recursively expand replacements', () => {
  for (const count of [1, 2, 3, 1000]) {
    expect(redactWebhookText('E', Array(count).fill('E'))).toBe('[REDACTED]');
  }
  expect(redactWebhookText('E', [...'[REDACTED]'])).toBe('[REDACTED]');
  // Raw receiver markers fail closed; only markers inserted by us are trusted.
  expect(redactWebhookText('[REDACTED]', [...'[REDACTED]'])).toBeUndefined();
  expect(redactWebhookText('{"token":"receiver-private","echo":"E"}', ['E', 'E']))
    .toBe('{"token":"[REDACTED]","echo":"[REDACTED]"}');
});

test('redaction enforces construction and pattern budgets and escapes literal patterns', () => {
  expect(redactWebhookText('E'.repeat(65_000), ['E', 'E', 'E'])).toBeUndefined();
  expect(redactWebhookText('public', Array.from({ length: 129 }, (_, i) => `fixture-${i}`))).toBeUndefined();
  expect(redactWebhookText('public', ['a'.repeat(16_385)])).toBeUndefined();
  expect(redactWebhookText('public', ['a'.repeat(9000), 'b'.repeat(9000)])).toBeUndefined();
  const secret = 'fixture.+(value)?/" private';
  for (const encoded of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), JSON.stringify(secret).slice(1, -1)]) {
    expect(redactWebhookText(`echo: ${encoded}`, [secret])).toBe('echo: [REDACTED]');
  }
  expect(redactWebhookText('still-public', ['.+(value)?'])).toBe('still-public');
});

test('full executor caps repeated URL-secret expansion and published response headers', async () => {
  const request = response(200, 'E'.repeat(65_000));
  request.mockResolvedValue({ statusCode: 200, body: 'E'.repeat(65_000), headers: { 'content-type': 'E'.repeat(4000), 'retry-after': 'E'.repeat(4000) }, truncated: false });
  const ctx = context({ ...base, url: 'https://example.com/E/E/E' });
  const progress: SendWebhookOutput[] = [];
  ctx.reportWebhookProgress = output => { progress.push(output); };
  const result = await sendWebhookExecutor.execute(ctx);
  expect(result.branch).toBe('success');
  expect(result.outputs.responseTruncated).toBe(true);
  expect(result.outputs.responseBody).toBe('');
  for (const output of progress) {
    expect(Buffer.byteLength(output.responseBody)).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(JSON.stringify(output.responseHeaders))).toBeLessThanOrEqual(8192);
  }
});

test('nested sensitive request containers redact separately echoed leaves and encodings in every progress record', async () => {
  const leaf = 'synthetic-sensitive-leaf';
  const arrayLeaf = 'synthetic-array-leaf';
  const secretRequest = { credentials: { value: leaf, inner: { numeric: 834272 } }, tokens: [{ value: arrayLeaf }, [leaf]] };
  const request = response(200, JSON.stringify({
    echo: leaf,
    encoded: Buffer.from(leaf).toString('base64'),
    other: arrayLeaf,
    urlEncoded: encodeURIComponent(arrayLeaf),
    nested: { value: Buffer.from(arrayLeaf).toString('base64url') },
    container: Buffer.from(JSON.stringify(secretRequest.credentials)).toString('base64'),
    numberEcho: '834272',
  }));
  const ctx = context({ ...base, body: JSON.stringify(secretRequest) });
  const progress: SendWebhookOutput[] = [];
  ctx.reportWebhookProgress = output => { progress.push(output); };
  const result = await sendWebhookExecutor.execute(ctx);
  expect(JSON.parse(request.mock.calls[0][3]!)).toEqual(secretRequest);
  expect(result.branch).toBe('success');
  expect(result.outputs.responseTruncated).toBe(false);
  expect(result.outputs.responseBody).toContain('[REDACTED]');
  const evidence = JSON.stringify([result, progress]);
  for (const secret of [leaf, arrayLeaf, '834272', Buffer.from(leaf).toString('base64'), Buffer.from(arrayLeaf).toString('base64url'), Buffer.from(JSON.stringify(secretRequest.credentials)).toString('base64')]) {
    expect(evidence).not.toContain(secret);
  }
});


test('receiver markers cannot shield prefix secrets or secrets overlapping at index one', () => {
  const raw = '[REDACTED]synthetic-fixture';
  for (const secret of [raw, raw.slice(1)]) {
    for (const text of [
      raw,
      JSON.stringify({ echo: raw }),
      '{"echo":"\\u005bREDACTED]synthetic-fixture"}',
      '{"\\u005bREDACTED]synthetic-fixture":"echo"}',
    ]) {
      expect(redactWebhookText(text, [secret])).toBeUndefined();
    }
  }
  expect(redactWebhookText(raw, [])).toBe(raw);
  // Markers created from sensitive keys remain stable even with short secrets.
  expect(redactWebhookText('{"token":"private","echo":"E"}', ['E']))
    .toBe('{"token":"[REDACTED]","echo":"[REDACTED]"}');
});

test('actual executor omits URL credential marker collisions from results and progress', async () => {
  const raw = '[REDACTED]synthetic-fixture';
  const request = response();
  for (const secret of [raw, raw.slice(1)]) {
    for (const body of [raw, '{"echo":"\\u005bREDACTED]synthetic-fixture"}']) {
      request.mockResolvedValue({ statusCode: 200, body, headers: { 'content-type': raw }, truncated: false });
      const ctx = context({ ...base, url: `https://example.com/${encodeURIComponent(secret)}` });
      const progress: SendWebhookOutput[] = [];
      ctx.reportWebhookProgress = output => { progress.push(output); };
      const result = await sendWebhookExecutor.execute(ctx);
      expect(result.branch).toBe('success');
      expect(result.outputs.responseTruncated).toBe(true);
      expect(result.outputs.responseBody).toBe('');
      expect(result.outputs.responseHeaders).toEqual({});
      const evidence = JSON.stringify([result, progress]);
      expect(evidence).not.toContain(raw);
      expect(evidence).not.toContain(secret);
    }
  }
});
