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

The unguessable `triggerId` in a webhook URL is the credential. There is **no HMAC signature verification** in the current build.

- Treat webhook URLs like passwords. Don't paste them in shared docs or screenshots.
- Rotate via the regenerate-id button in the Dispatch form.
- `INFLOOP_API_TOKEN` does **not** apply to webhook ingress — external services like GitHub can't carry custom auth headers.
- Signature verification (GitHub HMAC, Stripe signing) is planned; see [the roadmap](../README.md#status).

## Don't expose to the public internet

There is no rate limiting, no per-user auth, and no audit log. If you need a publicly reachable trigger surface, put Infinite Loop behind one of:

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

## Reporting security issues

Infinite Loop is pre-1.0 and currently has no formal disclosure channel. Open a GitHub issue for non-sensitive concerns; for anything that warrants private disclosure, contact the maintainer directly.
