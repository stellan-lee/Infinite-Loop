# Codex CLI profile support

**Status:** Approved

## Summary

Let an Agent node using the Codex CLI provider select a Codex configuration
profile, so the runner can execute `codex exec --profile <profile> <prompt>`
when the user sets one.

## Problem and current behavior

- **Confirmed fact:** `providers/codex.json` currently spawns `codex exec {prompt}`.
- **Confirmed fact:** `codex exec --help` exposes `-p, --profile <CONFIG_PROFILE_V2>`.
- **Confirmed fact:** `AgentConfig.profile` is typed as "Only meaningful for
  HTTP-transport providers"; CLI providers ignore it.
- **Confirmed fact:** `ConfigPanel.tsx` hides the Profile field for non-HTTP
  providers.
- **Concrete problem:** A workflow author cannot select a Codex config profile
  such as `codex -p xxx` for a specific Codex Agent node.

## Goals

- Set a per-node Codex profile from the Agent node config.
- Spawn Codex with `--profile <profile>` when a profile is configured.
- Preserve existing behavior when no profile is configured.
- Keep the mechanism local to CLI provider argument substitution and Codex
  manifest wiring.

## Non-goals

- Do not add profile discovery, profile validation, or profile management UI.
- Do not change Claude CLI behavior.
- Do not change HTTP provider model/profile behavior.
- Do not add persistent state, migrations, dependencies, credentials, workers,
  queues, or new services.
- Do not make profile selection a provider-wide server setting.

## Constraints and preserved invariants

- Existing workflows without `config.profile` must run exactly as before.
- Existing CLI provider manifests that do not declare a profile placeholder
  must ignore `profile`.
- HTTP provider `profile` remains the model/profile selected in the request
  body.
- Manifest validation and runner substitution remain the source of truth for
  what arguments a provider accepts.
- Profile values are user-authored workflow config, not secrets.

## Proposed change

1. Extend CLI argument substitution to support an optional `{profile}`
   placeholder with the same drop-on-empty flag-pair behavior as `{agent}`:
   - `["--profile", "{profile}"]` becomes `["--profile", "xxx"]` when set.
   - It drops to nothing when unset or blank.
2. Update `providers/codex.json` to declare the profile flag before the prompt:
   `["exec", "--profile", "{profile}", "{prompt}"]`.
3. Update shared `AgentConfig` / `RunnerOptions` comments so `profile` is
   meaningful for HTTP providers and for CLI providers that declare `{profile}`.
4. Update `ConfigPanel.tsx` to expose a Profile input for CLI providers that
   support it, while keeping HTTP provider behavior unchanged.
5. Update `docs/providers.md` to document the CLI `{profile}` placeholder and
   the Codex profile example.

## Ownership and boundaries

- `lib/server/providers/runner.ts` owns generic CLI argument substitution.
- `providers/codex.json` owns the Codex-specific profile flag placement.
- `lib/shared/workflow.ts` and `lib/shared/types.ts` own the runtime contract
  comments for `profile`.
- `app/components/ConfigPanel.tsx` owns the Agent node UI surface.
- `docs/providers.md` owns user-facing provider manifest documentation.

## Alternatives considered

- **Hard-code Codex behavior in `agentExecutor`.** Rejected: it would bypass
  manifest-driven provider configuration and create a special case outside
  the runner.
- **Add a Codex-specific UI branch by provider id.** Rejected: provider id
  special-casing duplicates knowledge that belongs in the manifest.
- **Add a new manifest field such as `profileArg`.** Rejected for this scope:
  `{profile}` can reuse the existing argument-template mechanism.
- **Make profile a global env/server setting.** Rejected: the user asked for
  per-node workflow selection, and a global setting would be less explicit.

## Security impact

Security impact: no material security-boundary change.

The profile name is workflow config and is passed as a CLI argument. It does
not change credential storage, transport, authorization, or egress policy.

## Compatibility, migration, and recovery

- No migration is needed because `profile` is already present in the workflow
  JSON contract and is optional.
- Existing saved workflows without `profile` are unchanged because the new
  placeholder drops its flag pair when empty.
- Invalid profile names or missing profiles fail through Codex CLI's own
  validation and surface in the Agent node stderr / exit output.
- The HTTP provider path remains byte-for-byte unchanged.

## Complexity introduced

- Components: one generic placeholder in CLI argument substitution.
- Persistent state: None.
- Migrations: None.
- Dependencies: None.
- Configuration: None.
- Credentials or trust: None.
- Workers or queues: None.

## Acceptance criteria

- `config.profile = "xxx"` on a Codex Agent node runs `codex exec --profile xxx <prompt>`.
- `config.profile` unset or blank on a Codex Agent node runs `codex exec <prompt>`.
- Claude Agent nodes remain unaffected unless their manifest later declares
  `{profile}`.
- HTTP Agent nodes continue to use `profile` as the request model/profile.
- The UI exposes a profile field for the Codex provider without hiding or
  breaking the existing Agent, Cwd, Worktree, and Outputs fields.

## Implementation contract

- Status: Proposal
- Observed problem: Codex CLI supports config profiles, but Infinite Loop's
  Codex provider manifest and Agent config UI ignore `AgentConfig.profile` for
  CLI providers.
- Exact desired behavior: an Agent node can set `profile`, and the Codex
  provider passes it as `codex exec --profile <profile>`.
- Included scope: generic `{profile}` CLI placeholder, Codex manifest wiring,
  shared type comment updates, Agent config UI profile field, provider docs.
- Explicit exclusions: profile discovery, profile validation, Claude support,
  global profile settings, migrations, and persistent state.
- Preserved contracts and controls: optional `profile`, blank drops flags,
  HTTP behavior unchanged, existing provider manifests unchanged unless they
  opt into `{profile}`, child env and egress controls unchanged.
- Likely affected subsystem: provider runner, Codex manifest, Agent config
  panel, shared workflow/provider types, provider documentation.
- Smallest regression coverage: `resolveCliArgs` tests for set/blank profile;
  Codex manifest or runner integration test; ConfigPanel UI test for the
  profile field; existing runner/Claude/HTTP tests unchanged.
- Direct validation: `bun test lib/server/providers/runner.test.ts
  app/components/ConfigPanel.test.tsx`; `bun run typecheck`; `git diff --check`.
- Security impact: no material security-boundary change.

## Validation

- Run focused runner tests for CLI argument substitution.
- Run focused ConfigPanel tests for the profile UI.
- Run `bun run typecheck`.
- Run `git diff --check`.
- Inspect final diff to confirm only approved files changed.

## Risks and open questions

- If Codex changes profile flag placement, the manifest must be updated; this
  is consistent with existing CLI provider manifest ownership.
- The UI can only know a CLI provider supports profile if the provider metadata
  exposes that capability or if the panel derives it from manifest data. The
  chosen implementation should avoid provider-id special-casing.

## Scope review

- Result: Passed
- Simplifications made: None
- Remaining decisions: None
