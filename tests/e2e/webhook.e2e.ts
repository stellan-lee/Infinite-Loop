/*
 * Smoke check — the webhook ingress loop.
 *
 * Creates a webhook trigger (authenticated), fires it with no credentials (the
 * unguessable triggerId is the credential), and confirms the durable audit log
 * records the acceptance. Exercises the one ingress surface that deliberately
 * bypasses `INFLOOP_API_TOKEN`.
 */
import { expect, test } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID } from './lib/env';

test('webhook ingress runs a workflow and is recorded in the audit log', async ({
  request,
}) => {
  const authed = { Authorization: `Bearer ${API_TOKEN}` };

  // Create a generic-plugin trigger bound to the seeded workflow.
  const createRes = await request.post('/api/triggers', {
    headers: authed,
    data: {
      name: 'E2E smoke trigger',
      enabled: true,
      workflowId: DEFAULT_WORKFLOW_ID,
      pluginId: 'generic',
      eventType: 'any',
      match: [],
      inputs: {},
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = await createRes.json();
  const triggerId: string = created.trigger?.id ?? created.id;
  expect(triggerId).toBeTruthy();

  // Fire the webhook with no auth header — the triggerId in the path is the
  // sole credential. The generic plugin declares no signature, so an unsigned
  // POST is accepted.
  const hookRes = await request.post(`/api/webhook/${triggerId}`, {
    headers: { 'content-type': 'application/json' },
    data: { hello: 'world' },
  });
  expect(hookRes.status()).toBe(202);
  const hookBody = await hookRes.json();
  expect(hookBody.queued).toBe(true);

  // The append-only audit log records the acceptance for this trigger.
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/audit?limit=50', {
          headers: authed,
        });
        if (!res.ok()) return [];
        const body = await res.json();
        return (body.entries ?? [])
          .filter(
            (e: { category: string; action: string; target: string }) =>
              e.category === 'webhook' &&
              e.action === 'accepted' &&
              e.target === triggerId,
          )
          .map((e: { outcome: string }) => e.outcome);
      },
      { timeout: 15_000 },
    )
    .toContain('success');
});
