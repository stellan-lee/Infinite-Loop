# Send Webhook node

Add **Send Webhook** from the palette or canvas context menu. The node sends an outbound HTTPS request only when execution reaches it. Editing, displaying and saving a node never sends a request. Incoming webhook triggers are a separate feature.

Configure a public HTTPS URL, GET / POST / PUT / PATCH / DELETE / HEAD, nonsecret headers and an optional JSON body. GET and HEAD require an empty body. Body templates must be valid JSON before substitution:

```json
{
  "message": "{{agent.stdout}}",
  "event": "{{inputs.eventId}}",
  "environment": "{{globals.environment}}"
}
```

The executor parses JSON first, resolves each string value with the existing template resolver, then serializes JSON. Quotes, newlines and braces in upstream output remain data. Values use the existing string conversion semantics. URL, header values and idempotency key also accept existing references. Missing references fail before sending.

## Authentication

Choose a bearer token or custom authentication header and enter a reference such as `PARTNER_TOKEN`. The server reads **only** `INFLOOP_WEBHOOK_SECRET_PARTNER_TOKEN`. Set that variable in the server's environment and restart the server after changing it. Workflow JSON stores the reference, never the secret. Do not put credentials in URLs, ordinary headers, body literals or workflow globals. Credential header names, URL userinfo and sensitive query parameters are rejected.

Authenticated requests require a literal HTTPS origin in the original URL, for example `https://partner.example/events/{{inputs.eventId}}`. Templated authorities are rejected and the resolved origin must remain identical. Secret references cannot read arbitrary server variables. Only configure secrets for trusted workflow authors and receivers.

## Limits and routing

- Success defaults to HTTP 200–299. An explicit list can include other statuses, except redirects. Success and failure follow their respective handles.
- Redirects always fail and are never followed, including same-origin redirects.
- The overall timeout defaults to 10 seconds and can range from 100 ms to 60 seconds. It includes admission, DNS, connect, response and retry delays. TLS connection establishment has a separate 5-second cap.
- One attempt is the default; up to three are allowed. Retries cover network/DNS/connect failures and HTTP 429, 502, 503 and 504. The configured fixed delay is 0–5000 ms (default 500 ms), within the same overall deadline. An exhausted overall deadline cannot retry.
- POST/PATCH retries require a stable idempotency key, resolved once and sent as `Idempotency-Key` on every attempt. The receiver must implement deduplication. Retries can duplicate effects; there is no exactly-once guarantee.
- A process-wide limit allows eight concurrent deliveries and 32 waiting nodes. Excess admission fails. Stop removes queued requests, aborts active requests and prevents later retries or failure continuation.
- Request JSON is capped at 64 KiB, headers at 8 KiB / 32 entries, URLs at 4096 characters, and response headers at 8 KiB. Response bodies over 64 KiB, or whose redaction exceeds bounded size/complexity limits, are omitted with `responseTruncated: true`, since incomplete JSON cannot be reliably redacted.

Only public unicast HTTPS destinations are allowed. All returned A and AAAA addresses are checked; one unsafe answer rejects the destination. Loopback, private, link-local, cloud metadata, reserved, multicast, mapped IPv6 and translation/tunnel ranges are blocked. The validated address is pinned to the socket while original Host/SNI and native TLS certificate verification are retained. There is no private-network bypass and no redirect following.

## Results and restart

The card and inspector show PENDING / RUNNING / SUCCEEDED / FAILED / CANCELLED, method, safe origin, last HTTP status, duration and attempt evidence. Paths and query strings are intentionally omitted from execution diagnostics and the card because webhook URLs commonly embed credentials. The URL remains editable in the inspector.

Downstream references include `{{send.status}}`, `{{send.statusCode}}`, `{{send.responseBody}}`, `{{send.durationMs}}` and `{{send.errorCategory}}` (replace `send` with your node ID). Structured outputs also include `responseHeaders`, `responseTruncated`, `attempts` and `errorMessage`. Only Content-Type, Content-Length and Retry-After response headers are retained. Known credential strings and common encodings, scalar descendants of sensitive request fields and sensitive JSON response fields are redacted. Redaction uses at most 128 distinct literal variants and 16 KiB of total variant text; excessive complexity safely omits the affected response data. When matching known secrets, receiver-supplied `[REDACTED]` markers (including JSON-escaped markers) also cause omission so they cannot shield an echoed credential. Treat receiver content as untrusted data; transformed secrets that cannot be recognized are not guaranteed detectable.

The controller saves a durable execution frame before the first request and persists sanitized attempt progress. A completed result resumes its normal continuation. After a server restart, an in-flight delivery fails through the failure handle with `errorCategory: "interrupted"` and retained attempt evidence. Its delivery is uncertain and is **never automatically replayed**. Check receiver state before deciding whether to run again. A checkpoint failure aborts execution rather than sending without durable evidence.

Ordinary workflows without this node retain their existing behavior. No test-send action, inbound endpoint, OAuth flow or receiver integration is added.
