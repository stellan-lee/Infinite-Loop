# Webhook guide

Open the **Dispatch** view (top-bar button, next to the workflow menu) to create, edit, and test webhook triggers visually. Each trigger gets a unique URL. When an HTTP POST hits it, Infinite Loop matches the trigger's predicates against the request, queues a workflow run with templated inputs, and returns `202 { queued, queueId, position, correlationId }`.

## Creating a trigger

1. **Dispatch → + New trigger**.
2. Name it and pick the target workflow.
3. Pick a **plugin** that describes the webhook source:
   - **Generic** — any JSON POST. Predicates and input mappings are free-form `{{body.x.y.z}}` template strings.
   - **GitHub** — declares `push`, `issues`, `issue_comment`, and `pull_request` events; the form's field picker autocompletes from the event's schema.
   - Drop a JSON file in `webhook-plugins/` to add more (see [Adding a plugin](#adding-a-plugin)).
4. Configure **Match** predicates (AND-joined). For GitHub the `x-github-event` header check is implicit — pick the event in the form, and you only write predicates for body fields.
5. Map **Inputs** — each declared workflow input becomes a row; fill in a template string using the field picker.
6. **Save**, then copy the URL from the detail pane.

## Wiring up GitHub

Infinite Loop listens on `http://localhost:3000` by default. To reach it from `github.com`, expose your machine with a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then in your repo: **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<your-tunnel>.trycloudflare.com/api/webhook/<id>` |
| Content type | `application/json` |
| Secret | (leave blank — the URL is the credential in v2) |
| Events | Pick specific events, or "Send everything" and filter in Dispatch |

## Test fire

Hit **Test** on any trigger row to open the test-fire modal. Edit a JSON payload (pre-filled from the plugin's example), set headers, and Send. You'll see the real webhook response (202, 204, 422, …) so you can debug predicates and input mapping without leaving the UI.

## Received messages

Open **Dispatch → Messages** to inspect deliveries across all Dispatch plugins. The history includes test fires, ignored messages, and rejected requests, including requests to unknown or disabled triggers. Filter by trigger or workflow, select a message to inspect it, and use **Load older** to browse earlier deliveries.

Each message records its receipt time, source service, sender identity when supplied by the payload, request body, trigger, target workflow, and HTTP outcome. Sender identities are claims from the payload. Unknown trigger URLs have no configured source or workflow to display.

Workflow state updates from **Queued** to **Running** and then to its final status. A running workflow shows its current state; completed workflows show their output or failure details. Messages and recorded results persist across server restarts independently of run-history retention.

Body capture is bounded at 1 MiB. Oversized or unreadable bodies are explicitly marked as truncated or unavailable. Receipt history is protected by the same authentication as the management API; incoming webhook URLs still use their existing authentication rules. If a receipt cannot be created on disk, the server returns `503 receipt-unavailable` before starting a workflow.

The history covers Dispatch's `/api/webhook/<triggerId>` endpoint. The separate GitHub CI reconciliation receiver at `/api/webhook/github-ci` is outside this history.

## Adding a plugin

Plugins are pure JSON. Create `webhook-plugins/<id>.json`:

```json
{
  "id": "stripe",
  "displayName": "Stripe",
  "eventHeader": "stripe-event-type",
  "events": [
    {
      "type": "checkout.session.completed",
      "displayName": "Checkout session completed",
      "fields": [
        { "path": "body.data.object.id",       "type": "string" },
        { "path": "body.data.object.amount",   "type": "number" },
        { "path": "body.data.object.customer", "type": "string" }
      ],
      "examplePayload": { "data": { "object": { "id": "cs_…", "amount": 5000 } } }
    }
  ]
}
```

Restart Infinite Loop. The plugin appears in the trigger form's plugin dropdown.

## Behavior reference

- Match succeeds → `202 { queued, queueId, position, correlationId }`. The run is queued; the queue is persisted to disk, so a restart never drops it. The `correlationId` (`cid_…`, also returned in an `x-correlation-id` header) threads through the run's events, audit entries, and history record — `grep` it to trace a webhook end to end.
- Match fails or plugin event-header mismatches → `204 No Content`.
- Unknown / disabled trigger id → `404 not-found`.
- Body > 1 MiB → `413 payload-too-large`.
- Queue at cap (100) → `503 queue-full` with `Retry-After: 30`.

## Security

The unguessable `triggerId` in the URL is the credential. There's no HMAC verification in v2 — **treat trigger URLs like passwords**; rotate via the regenerate-id button in the Dispatch form.

`INFLOOP_API_TOKEN` does **not** apply to webhook ingress (external services can't carry custom auth headers); it gates the management API only. See [security.md](security.md) for the full picture.

## Limitations

- No service-specific signature verification (GitHub HMAC, Stripe signing) yet — planned as a follow-up.

## Storage

- `triggers/<id>.json` — one file per trigger.
- `webhook-plugins/<id>.json` — one file per plugin (Generic is built-in; you don't need to ship a file for it).
- `<data directory>/webhook-receipts/` — saved request bodies, workflow results, and lightweight list summaries. Receipts are not automatically pruned, so storage usage grows with deliveries and retained payloads.
