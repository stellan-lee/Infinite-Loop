# Per-worker Codex home overrides

Status: Approved — explicit human approval received. The subsequent deliver-pr invocation authorizes the shipping phase after validation and independent review.

Ticket: [#48](https://github.com/stellan-lee/Infinite-Loop/issues/48)

## 1. Background and context

Codex Agent nodes currently receive the operator's `HOME` through the base
child-environment allowlist and any inherited `CODEX_HOME` through the Codex
manifest's `CODEX_*` passthrough. Authors cannot independently override either
directory for a worker. This causes workers to discover host user instructions,
Skills, and configuration even when their working directories differ.

The existing path is workflow JSON → Agent form/store → `agentExecutor` →
`runProvider` → a scrubbed child environment passed to `spawn`. Agent nodes
already select a working directory and can replace it with a run-owned Git
worktree before invoking the runner. Provider-specific command arguments and
editor capabilities are already manifest-driven.

WHY: Give workflow authors explicit control over each worker's user-level
discovery and Codex configuration roots without modifying the server's home.

WHAT: Two optional, independent settings on a Codex Agent node, with
deterministic paths, pre-launch directory setup, and path-only diagnostics.

HOW: Pass the settings through the existing node/runner contract and apply
them to a fresh child-environment object immediately before process launch.
Use the provider manifest to declare the required login-shell restriction.

## 2. Goals and non-goals

Goals:

- Independently configure `HOME` and `CODEX_HOME` for each Codex worker.
- Support absolute paths and paths relative to the final worker directory.
- Create explicitly requested directories before launching the child, or fail
  with an actionable error identifying the setting and path.
- Disable Codex login shells when either override is configured.
- Preserve existing launch behavior when neither setting is configured.
- Show effective home paths without reading or logging credentials/config.
- Cover the actual process environment, argv, and node-to-worker launch path.

Non-goals:

- OS filesystem isolation, changing permission/approval policy, or preventing
  an agent from explicitly accessing readable host files.
- Copying credentials, syncing config, or editing existing Codex config files.
- A general environment-variable editor, provider-wide defaults, or new stores.
- New interactive/PTY execution, arbitrary shell expansion, or new templating
  behavior for these fields.
- Deployment and live-data migration. Shipping (commit, push, and a Draft PR) is separately authorized by the subsequent deliver-pr invocation.

## 3. Proposed design

### Configuration and editor

Add optional `home?: string` and `codexHome?: string` to `AgentConfig` and
`RunnerOptions`. They represent `HOME` and `CODEX_HOME`, respectively. Store
them in existing workflow JSON; no version bump or migration is needed.

Expose separate HOME and CODEX_HOME text fields on capable Agent nodes using
the existing debounced optional-field pattern. Explain the relative-path root,
blank behavior, and automatic login-shell restriction beside the controls.
Clearing a field removes its override. Switching providers must not discard
saved values silently; attempting to run configured overrides through an
unsupported provider returns an error instead of implying isolation worked.

Validate at save and runtime boundaries: absent or blank strings are unset;
other supplied values must be strings without NUL bytes. Trim surrounding
whitespace, consistent with existing optional profile/model fields. Paths are
literal: no `$VAR`, `~`, or `{{...}}` expansion is introduced by this feature.

### Provider capability and login-shell arguments

Add optional `homeOverrideArgs?: string[]` to CLI manifests. If present, it
must be a nonempty array of nonempty strings; reject `[]` rather than treating
it as support without a shell restriction. Absence means unsupported. Validate
this in the provider loader. The shipped Codex manifest declares:

```json
{ "homeOverrideArgs": ["-c", "allow_login_shell=false"] }
```

Publish `manifestSupportsHomeOverrides` through existing provider metadata so
the editor does not identify Codex by a hard-coded provider id or executable
name. Only the shipped Codex manifest opts in in this change.

When either setting is configured, prepend these manifest arguments to the
resolved argv, before the subcommand. When neither is configured, leave argv
and environment behavior unchanged. Reject configured overrides for manifests
without this capability, including HTTP providers, before provider execution.

The [official configuration reference](https://developers.openai.com/codex/config-reference/)
documents that `allow_login_shell=false` makes omitted login settings use
non-login shells and rejects explicit login-shell requests. It is a process
configuration override, not an edit to a user's config file.

### Paths, environment, and failure handling

1. `agentExecutor` passes both configured paths alongside its final
   `spawnCwd`, after worktree creation and under existing directory-lock and
   resource-cleanup ownership.
2. The runner validates supplied values and capability support before any
   directory/proxy setup or HTTP execution. The CLI runner then resolves each
   configured path independently against
   `path.resolve(opts.cwd)`. Absolute paths retain their meaning. Worktree
   workers therefore resolve relative homes inside their actual worktrees.
3. Recursively create each explicitly requested directory before starting a
   child or allocating a per-run egress proxy. Existing directories are reused;
   a file collision or permissions error fails before spawn. Do not remove
   requested directories on failure or completion: they may hold reusable
   state. Relative directories inside a run-owned worktree follow its existing
   run-end cleanup lifecycle; document absolute paths for persistent state.
4. Build the child's existing scrubbed environment with `buildChildEnv` and
   merge HOME/CODEX_HOME overrides with the existing proxy overrides. Preserve
   secret filtering and proxy enforcement. Never mutate `process.env`.
5. Only set variables explicitly configured. With only HOME configured, an
   inherited CODEX_HOME stays inherited; when CODEX_HOME is absent, Codex uses
   its normal default under the effective home. With only CODEX_HOME
   configured, HOME keeps its existing value. Do not infer that setting one
   authorizes replacing the other.
6. Setup errors return the existing unsuccessful `RunnerResult` shape with a
   setting-specific message, and the Agent node follows its `error` branch.
   Preserve existing lock/MCP cleanup, cancellation, and timeout behavior;
   check cancellation before starting a child after asynchronous setup.

Two invocations construct independent environment objects and resolve relative
paths against their own worker roots. Authors may explicitly choose a shared
absolute CODEX_HOME to reuse authentication/configuration, accepting Codex's
existing concurrent-access behavior for that directory.

### Diagnostics and supported launch modes

When either override is configured, emit one pre-launch diagnostic through
the existing stdout callback with JSON-escaped path values from the final child
environment and `allow_login_shell=false`. If CODEX_HOME is unset, label it as
unset with the normal HOME-relative default, rather than claiming an explicit
override. Never enumerate the environment or read auth/config contents. Keep
diagnostics out of the provider's accumulated response text.

All current Codex launches use the same noninteractive `codex exec` runner;
there is no interactive or PTY launch path in this repository. Argument and
stdin prompt delivery use the same environment setup. Adding an interactive
launcher is outside this ticket's "where supported" requirement.

### Ownership and expected affected files

- `lib/shared/workflow.ts`, `lib/shared/types.ts`: optional settings and
  shared shape validation where appropriate.
- `lib/server/workflow-store.ts`: save-time config validation.
- `lib/server/providers/types.ts`, `loader.ts`, `providers/codex.json`:
  manifest capability and fixed Codex login-shell arguments.
- `app/api/providers/route.ts`, `app/components/ConfigPanel.tsx`: capability
  projection and per-node editing.
- `lib/server/nodes/agent.ts`: forward config, reject unsupported launches,
  and preserve existing cleanup ownership.
- `lib/server/providers/runner.ts`: path preparation, child environment,
  conditional arguments, and diagnostics. A small adjacent helper is acceptable
  if it makes these operations directly testable without a new abstraction.
- Focused existing test suites and a fixture that prints only named test
  paths/argv; `docs/providers.md` and `docs/workflow-format.md`: user contract.

## 4. Alternatives considered

- Set HOME/CODEX_HOME on the server environment: insufficient for distinct
  workers and risks affecting concurrent requests and unrelated processes.
- Add generic per-node environment maps: exposes unnecessary variables and
  policy decisions; two explicit settings cover this ticket.
- Hard-code the provider id in editor and runner: smaller initial plumbing,
  but duplicates provider-specific knowledge and breaks renamed manifests.
  A manifest capability follows the existing provider-driven editor pattern.
- Always disable login shells in the Codex manifest: simpler arguments, but
  changes existing workers without configured overrides.
- Resolve relative paths against server cwd or pre-worktree cwd: predictable
  globally, but fails the intended per-worker root behavior.

## 5. Risks and open questions

- Environment roots control discovery, not filesystem access. Ancestor/project
  instructions and explicitly shared configuration remain intentional inputs.
- A fresh CODEX_HOME may require operator-provided authentication and model
  configuration. Missing auth is surfaced through normal Codex errors; nothing
  is copied from the host automatically.
- Existing Codex configuration can influence subprocess environment policy;
  verify the supported CLI's actual discovery and shell behavior separately
  from fixture tests. Do not equate a fake process smoke test with real Codex
  Skills discovery evidence.
- A future interactive launcher must reuse this preparation contract. None
  exists today, so this proposal does not introduce one.
- Remaining design questions: none; the choices above require human approval.

## 6. Impact

Only configured workers gain filesystem setup and changed launch arguments.
No new dependencies, persistence layer, queue, migration, or global settings.
Existing workflows retain their previous behavior. Directory creation is
idempotent; persistent homes remain operator-owned. Shared homes intentionally
share Codex state and are not advertised as independent configuration storage.

## 7. Success criteria and validation

After approval, implementation must satisfy every ticket acceptance criterion:

- Unit/process tests: both settings, each setting alone, inherited-variable
  precedence, blanks, absolute/relative paths, spaces, repeated launches,
  directory setup failures, conditional login-shell argv, and cancellation.
- Regression tests: unset config preserves existing argv/environment behavior;
  child secret filtering and enforced proxy environment remain intact.
- Worker-level fixture smoke test: execute an Agent node through provider
  loading and real child spawn; assert child HOME/CODEX_HOME and argv, directory
  existence before launch, worktree path anchoring, and two concurrent workers
  with distinct roots without parent-environment mutation.
- Editor/provider/store tests: independent field updates and clearing,
  capability visibility, unsupported-provider errors, invalid value rejection,
  and workflow save/read round-trip.
- Diagnostics tests: effective paths visible, control characters escaped,
  credentials/config content absent, and response text remains unchanged.
- Bounded real-Codex check: verify isolated HOME does not discover host user
  Skills while project-local Skills remain discoverable; isolated CODEX_HOME
  selects that root; omitted and explicit login requests cannot reset HOME.
  Use disposable roots and no copied host credentials. If CLI/auth support
  prevents this check, report it as BLOCKED and leave the related acceptance
  criteria unverified rather than claiming the ticket complete.
- Run focused suites first, then `bun run typecheck`, `bun test`,
  `bun run build`, and `git diff --check`. Inspect final status and full scope.
- Independent implementation review is required after validation. Leave code
  uncommitted/unstaged for the next explicit shipping phase.

Design-stage validation: source and existing tests inspected; no product code
changed and no implementation tests run at that stage. Explicit human approval
subsequently authorized implementation; deliver-pr authorizes shipping after gates.

Read-only design subagent review: completed. Incorporated explicit empty-array
capability rejection and validation ordering. Confirmed environment precedence,
final-worktree resolution, directory lifetime, diagnostic separation, and the
distinction between fixture smoke tests and real Codex behavior checks.
