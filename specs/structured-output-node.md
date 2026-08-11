# Structured Output Node

Status: Approved

## Summary

Add a `structured-output` workflow node that makes one non-streaming request to
an existing OpenAI-compatible HTTP provider. The author configures a prompt and
a JSON Schema; the provider is required to return a value using OpenAI's strict
`json_schema` response format. The node stores the parsed value as its `result`
output and routes failures to its existing `error` handle.

## Problem and current behavior

- **Confirmed fact:** The canvas can add only the current fixed set of node
  types; all node creation flows converge in `Canvas.tsx`.
- **Confirmed fact:** OpenAI-compatible HTTP providers are already configured
  through provider manifests or local Hermes connections. Their credentials
  remain server-side.
- **Confirmed fact:** The HTTP provider runner only makes streaming
  `/chat/completions` calls and returns plain text. It has no strict JSON Schema
  request or response path.
- **Confirmed fact:** Agent nodes provide the existing model/provider selection
  and prompt-form pattern.
- **Strong inference:** “just as an Agent Node” means this is a runtime node on
  the workflow canvas, not an AI assistant that authors other canvas nodes.

Today an author cannot add a workflow step whose one-turn model response is a
typed JSON value governed by an imported JSON Schema.

## Goals

- Let an author add a Structured Output node from the canvas palette and
  context menu.
- Let the author select an existing HTTP provider and its model/profile, enter
  a templated prompt, and supply a JSON Schema through the node form.
- Provide a local JSON-file import action that loads the schema into that form;
  the file is not uploaded or persisted separately.
- Make exactly one OpenAI-compatible `/chat/completions` request per node
  execution, using strict `json_schema` response formatting.
- Expose the successfully parsed response at `{{<node-id>.result}}` and follow
  normal `next` / `error` routing.

## Non-goals

- Do not generate or edit canvas nodes from natural-language authoring prompts.
- Do not support CLI providers, multi-turn conversations, streaming output,
  retries, tool calls, or fallback JSON parsing.
- Do not add a second endpoint, model, or API-key store. Provider manifests and
  local connections remain the only provider and credential configuration.
- Do not validate or transform the schema locally beyond confirming that the
  imported or entered text is valid JSON and a JSON object. The object-root
  requirement follows the OpenAI-compatible `response_format.json_schema`
  contract; unsupported strict-schema features fail through the provider
  response.
- Do not add edges automatically or change downstream templating behavior.

## Constraints and preserved invariants

- **Proposed decision:** The node supports HTTP providers only. It reuses the
  existing provider id, profile/model discovery, authentication, and timeout
  conventions; the workflow never stores an API key.
- **Proposed decision:** The node's JSON Schema is stored as JSON workflow
  configuration, alongside its prompt. It must not contain credentials.
- Existing workflow node types, Agent execution, HTTP streaming behavior, and
  provider manifests remain unchanged.
- A node insertion continues to receive its id, position, undo history, dirty
  state, and autosave behavior from the existing canvas/store path.
- A failed provider call, a refusal, an empty response, invalid JSON, or an
  unsupported `json_schema` request routes to `error` with a bounded,
  user-actionable error message. No second model call is made.

## Proposed change

1. Extend the workflow node contract with `structured-output` and a config
   containing `providerId`, optional `profile`, `prompt`, `schema`, and
   `timeoutMs`. Its default config mirrors an HTTP Agent node's usable defaults
   except that the schema starts empty.
2. Add the node to the palette, context menu, canvas node renderer, and
   configuration panel. The configuration panel follows the Agent form's
   provider/profile and prompt controls, but limits providers to HTTP transport
   and adds a JSON Schema editor with an **Import JSON Schema** file action.
   File import is client-side: read the selected file as text, parse it as JSON,
   then place a normalized JSON representation in the schema editor. Invalid
   files leave the current schema unchanged and show a field error.
3. Add a dedicated one-shot HTTP-provider operation. Given an HTTP manifest,
   resolved prompt, selected/default model, timeout, and schema, it sends one
   non-streaming `/chat/completions` request with the existing bearer-auth
   resolution and:

   ```json
   {
     "model": "<selected profile>",
     "messages": [{ "role": "user", "content": "<resolved prompt>" }],
     "stream": false,
     "response_format": {
       "type": "json_schema",
       "json_schema": {
         "name": "structured_output",
         "strict": true,
         "schema": "<configured JSON Schema object>"
       }
     }
   }
   ```

   The existing streaming Agent operation remains separate and unchanged.
4. Add the Structured Output executor. It validates the local config before
   calling the provider; invokes the one-shot operation once; parses the
   returned assistant content as JSON; and writes the parsed value as `result`.
   It routes success to `next`; every failure routes to `error` with
   `errorMessage` and normal timing/exit metadata consistent with node
   executors.

## Ownership and boundaries

- `lib/shared/workflow.ts` owns the node/config and output contract.
- The canvas, palette, context menu, and ConfigPanel own creation and authoring
  UI.
- The provider layer owns strict OpenAI-compatible request construction,
  authorization header reuse, timeout, and response extraction.
- The Structured Output executor owns configuration checks, exactly-once call
  behavior, JSON parsing, and `next`/`error` routing.
- Existing provider manifests/local connections own endpoint, model discovery,
  and credential storage.

## Alternatives considered

- **Create a separate endpoint/model/API-key settings store.** Rejected: it
  duplicates the existing HTTP provider and credential ownership.
- **Use a normal Agent node and parse its text in a downstream Script node.**
  Rejected: it cannot require strict provider-side JSON Schema output and adds
  an extra workflow step.
- **Allow plain JSON fallback.** Rejected: the approved requirement is strict
  JSON Schema; accepting a best-effort text response weakens that contract.
- **Retry malformed responses.** Rejected: the first milestone is exactly one
  turn.

## Security impact

Security impact: no material security-boundary change.

The node reuses existing server-side HTTP-provider credential handling. Its
schema and prompt are workflow content and must not be treated as secrets.

## Compatibility, migration, and recovery

- Existing workflows are unchanged because `structured-output` is a new node
  type.
- Existing HTTP Agent nodes keep their streaming plain-text request shape.
- Providers that do not implement OpenAI strict JSON Schema return an error at
  execution time; the workflow can route that error without retrying or
  altering saved configuration.
- Removing a Structured Output node uses the existing canvas deletion and
  workflow autosave behavior.

## Complexity introduced

- Components: one node renderer and one configuration form section.
- Persistent state: one new node configuration stored in existing workflow JSON.
- Dependencies: None.
- Configuration: None; reuse existing HTTP provider configuration.
- Credentials or trust: None; reuse existing credential ownership.
- Workers or queues: None.

## Acceptance criteria

- The palette and context menu can add a Structured Output node with normal
  canvas placement, undo, and autosave behavior.
- The node form accepts a prompt, only lists HTTP providers, can select a
  discovered/fallback model profile, and imports a valid JSON Schema file into
  the schema editor without uploading that file.
- A valid saved node sends exactly one non-streaming request with
  `response_format.type = "json_schema"` and `json_schema.strict = true`.
- On a valid JSON completion, `result` is the parsed JSON value and the node
  follows `next`.
- Invalid local config, provider/network errors, provider refusals, unsupported
  strict-schema errors, empty content, and invalid JSON produce `error` without
  a retry.
- Existing Agent node execution and CLI-provider behavior pass unchanged.

## Validation

- Focused unit tests for config validation, strict request payload construction,
  success/error parsing, timeout/abort, and no-retry behavior.
- Component tests for the form's HTTP-only provider selection and local schema
  import behavior.
- Canvas/palette/context-menu tests for new-node insertion.
- Run relevant `bun test`, then `bun run typecheck` against the final state.

## Risks and open questions

- **Assumption for approval:** The requested feature is a runtime Structured
  Output node, not a prompt-driven canvas-authoring assistant. A different
  interpretation requires a new design.
- Strict JSON Schema support varies across OpenAI-compatible endpoints. This
  milestone surfaces the provider error rather than adding compatibility modes.

## Scope review

- Result: Passed
- Simplifications made: Reused existing HTTP-provider credentials, provider
  discovery, selection UI patterns, canvas insertion, and workflow persistence;
  excluded a separate settings store, CLI support, fallback parsing, retries,
  streaming, and automatic wiring.
- Remaining decisions: None.
