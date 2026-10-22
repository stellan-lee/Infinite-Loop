# GitHub CI Gate

Place a **GitHub CI Gate** after the node that creates or updates a pull request. The repository and pull request fields support templates, for example `{{create-pr.repository}}` and `{{create-pr.number}}`. Repository values use `owner/repository`; pull requests use a positive number.

Configure each requirement with its exact name and a kind: **Check** for a check run, or **Workflow** for an Actions workflow. At least one requirement is mandatory. A workflow named `build` and a check named `build` are separate requirements. Optional results appear in the inspector but do not block the gate.

```json
{
  "id": "ci",
  "type": "github-ci",
  "position": { "x": 500, "y": 100 },
  "config": {
    "repository": "{{create-pr.repository}}",
    "pullRequest": "{{create-pr.number}}",
    "required": [
      { "kind": "check", "name": "test" },
      { "kind": "workflow", "name": "Build" }
    ],
    "timeoutMs": 3600000
  }
}
```

Connect the `success` output to the next step and `failure` to a repair agent or an end node. An unconnected failure output fails the run. A repair node can read `{{ci.checks}}`, `{{ci.required}}`, `{{ci.failed}}`, `{{ci.pending}}`, `{{ci.headSha}}`, and `{{ci.errorMessage}}`. The structured output also includes repository, PR number and link, aggregate status, required count, and passed count. The canvas shows a compact summary; selecting the node shows individual conclusions, summaries, and GitHub links.

## Server setup

Set `INFLOOP_GITHUB_TOKEN` and `INFLOOP_GITHUB_WEBHOOK_SECRET` in the server environment. The token needs read access to Actions, Checks, and Pull requests on the target repository. A GitHub App installation access token is supported; the operator is responsible for refreshing expiring tokens. Credentials are never stored in workflow definitions or outputs.

Configure the GitHub App webhook URL as `https://your-server/api/webhook/github-ci`, set the matching webhook secret, and subscribe to `workflow_run`, `check_run`, `check_suite`, and `pull_request`. Opened, reopened, and synchronized PR events trigger reconciliation. The webhook endpoint requires `X-Hub-Signature-256` even when application authentication is disabled. A missing secret returns 503; an invalid signature returns 401. Authenticated routing hints are persisted before the 202 response, and processed asynchronously. Duplicate delivery IDs are idempotent; event order cannot substitute stale payload conclusions for GitHub's current state.

## Decisions and reconciliation

The gate resolves the current PR head, fetches paginated check runs and workflow runs for that exact SHA, and rechecks the PR head before publishing its result. A changed head discards the old aggregate. Three repeatedly changing head reads settle as Error. Checks and Actions workflow IDs are tracked separately. Within each requirement, the latest check run per GitHub App ID or the latest workflow run/attempt per workflow ID supersedes older attempts. If several apps or workflows share a required name, all matching identities must succeed. A same-name pending rerun cannot be masked by an older success.

Only `completed` with `success` passes. Missing results, null conclusions, and unrecognized conclusions stay Pending (or Running when a required check is in progress). Required `failure`, `timed_out`, `action_required`, `startup_failure`, and `stale` conclusions fail. A required `cancelled` conclusion produces Cancelled; `skipped` and `neutral` produce Error. These all use the failure output. Unknown results never pass by timeout: the positive `timeoutMs` limit produces Error. The run duration budget also bounds the wait. Stopping a run cancels its wait and does not dispatch downstream work.

Reconciliation runs when entering a gate, on relevant webhook deliveries, and on recovery. There is no polling interval. To recover missed events while a gate is waiting, call authenticated `POST /api/github-ci/reconcile` (the same token/session policy as other application APIs). API failures, expired credentials, invalid responses, inconsistent pagination, or GitHub's 1,000-result query ceiling settle Error rather than reusing cached success. Fix the underlying problem and start a new run or follow the workflow's failure path.

## Restart behavior

When a run first enters a CI gate, it persists its workflow definitions, scopes, budgets, worktrees, and explicit execution continuations under `INFLOOP_DATA_DIR/durable-runs`. Further transitions are checkpointed before advancing. The authenticated webhook inbox lives under `INFLOOP_DATA_DIR/github-ci-inbox`. Preserve this data directory across restarts.

A recovered wait keeps its original run ID, deadline, loop iteration, and child workflow definition. Completed upstream nodes and completed parallel siblings are not replayed. An ordinary executor still in flight when the server crashed is marked interrupted and routed through its error handling; arbitrary external operations cannot safely be resumed. Existing parallel failure policies apply. Missing retained worktrees cause an explicit run failure. Terminal checkpoints precede cleanup and history writes, preventing a cleanup crash from restarting completed execution. Checkpoint failures stop progression.

A run releases its worker slot when every active branch is waiting for CI. An active non-CI sibling keeps the slot. Directory-lock observers and worktree ownership remain until run settlement. Workflows that never enter a CI gate do not write continuation checkpoints.

The gate decides against the PR head at its final authoritative read. A later commit after the gate has completed requires another gate invocation; completion does not retroactively undo downstream work. Legacy commit statuses are outside this node's required check/workflow contract.
