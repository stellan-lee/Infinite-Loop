# Provider manifests

Each agent node picks a runner from `providers/*.json`. A manifest declares either a CLI to spawn or an HTTP service to call, and tells the engine how to parse the output. Drop in a new manifest and the palette picks it up; the agent's config panel exposes it as a selectable provider.

## CLI provider

```json
{
  "id": "claude",
  "label": "Claude",
  "description": "spawn claude --print",
  "glyph": "⟳",
  "bin": "claude",
  "args": [
    "--dangerously-skip-permissions",
    "--print",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--agent", "{agent}",
    "{prompt}"
  ],
  "outputFormat": "claude-stream-json",
  "promptVia": "arg"
}
```

| Field | Purpose |
|---|---|
| `id` | Unique provider id. Referenced by Agent nodes as `providerId`. |
| `label`, `glyph` | UI labels for palette and node title. |
| `bin` | The binary to spawn. Override per-install via `INFLOOP_PROVIDER_BIN_<ID>` (id upper-cased). |
| `args` | Argument template. `{prompt}` / `{agent}` / `{profile}` / `{model}` are substituted at runtime. |
| `outputFormat` | `claude-stream-json` for token-by-token streaming, `plain` for end-of-process stdout. |
| `promptVia` | `arg` (passed positionally) or `stdin`. |
| `{profile}` placeholder | Optional flag-value placeholder, like `{agent}`. `["--profile", "{profile}"]` expands when the node sets `profile`, and drops to nothing when blank. |
| `{model}` placeholder | Optional flag-value placeholder for model selection. `["--model", "{model}"]` expands when the node sets `model`, and drops to nothing when blank. |
| `envPassthrough` | Host env var names / `PREFIX_*` wildcards the spawned child may see, on top of the scrubbed non-secret base allowlist. |
| `egressAllowlist` | Hostnames the spawned child may reach — exact (`api.anthropic.com`) or leading-wildcard (`*.anthropic.com`, any subdomain, not the apex). Enforced per run via a loopback filtering proxy when `INFLOOP_EGRESS_ENFORCE=1`; absent or enforcement off → unrestricted egress. See [security.md](security.md#per-run-egress-allowlist). |

## HTTP provider

```json
{
  "label": "MyHermes",
  "host": "http://192.168.50.159",
  "token": "your-token",
  "ports": [
    { "port": 8643, "profile": "productmanager" },
    { "port": 8642, "profile": "hermes-agent" }
  ]
}
```

HTTP providers don't spawn a process; they POST to the declared host/port. The Agent node's `profile` config selects which port to use. Output is treated as `plain`.

## Shipped manifests

| File | Provider |
|---|---|
| `providers/claude.json` | Claude CLI with `--print --output-format stream-json` for live token streaming |
| `providers/codex.json` | Codex CLI (`codex exec [--profile <profile>] [--model <model>] <prompt>`) |
| `providers/myhermes.hermes.local.json` | Sample Hermes HTTP runner |

## Binary overrides

Two env vars override which binary actually runs:

- **`INFLOOP_PROVIDER_BIN_<ID>`** — per-provider override, where `<ID>` is the manifest id upper-cased (e.g. `INFLOOP_PROVIDER_BIN_CLAUDE=/opt/claude`).
- **`INFLOOP_CLAUDE_BIN`** — legacy alias for the `claude` provider, kept for back-compat.

See [configuration.md](configuration.md) for the full env-var reference.

For the shipped Codex runner, make sure `codex` is on your `PATH` for local
runs. If your Codex CLI lives somewhere else, start Infinite Loop with:

```bash
INFLOOP_PROVIDER_BIN_CODEX=/path/to/codex bun run dev
```
