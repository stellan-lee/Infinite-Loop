import type { LineParser, LineParserFactory } from './index';

/**
 * Anthropic Messages API streaming + claude CLI's `--output-format stream-json`
 * wrapper. Surfaces three classes of frames into the run-log text stream:
 *
 *   1. Text deltas — `content_block_delta` + `text_delta` — streamed verbatim.
 *   2. Tool calls — `tool_use` blocks inside the rolled-up `assistant` frame —
 *      rendered as `[tool: <name>] <summary>` (or `[subagent: <type>] <desc>`
 *      for the Task tool). We render from the rolled-up frame rather than
 *      `input_json_delta` because by then the input is complete.
 *   3. Tool results — `tool_result` blocks inside the next `user` frame —
 *      rendered as `[tool result] <body>` / `[subagent result] <body>`.
 *   4. Run summary — the top-level CLI `result` event — rendered as
 *      `[result: <subtype> | $<cost> | <tok in> + <tok out> | <duration>s]`.
 *
 * The rolled-up `assistant`/`message` text content is swallowed (it already
 * streamed via deltas) to avoid duplicating the model's reply.
 *
 * State is per-factory-instance: each `createClaudeStreamJsonParser()` call
 * returns a parser with its own in-flight `tool_use_id → name` map. The
 * runner creates one parser per CLI invocation, so concurrent agent branches
 * (e.g. the `parallel` node) cannot interleave tool-use tracking.
 *
 * Returns `kind:'plain'` for non-JSON lines so the runner falls back to
 * passthrough — useful when fixtures or stderr leaks land on stdout.
 */

const TRUNCATE_AT = 200;

export const createClaudeStreamJsonParser: LineParserFactory = () => {
  const inflightTools = new Map<string, string>();

  const parse: LineParser = (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { kind: 'plain' };
    }
    if (!parsed || typeof parsed !== 'object') return { kind: 'plain' };
    const obj = parsed as Record<string, unknown>;

    if (obj.type === 'content_block_delta') {
      const delta = asObject(obj.delta);
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
        return { kind: 'json', text: delta.text };
      }
      return { kind: 'json', text: '' };
    }

    if (obj.type === 'stream_event') {
      const event = asObject(obj.event);
      if (!event) return { kind: 'json', text: '' };
      const inner = parse(JSON.stringify(event));
      return inner.kind === 'json' ? inner : { kind: 'json', text: '' };
    }

    if (obj.type === 'assistant') {
      return renderAssistant(obj, inflightTools);
    }
    if (obj.type === 'user') {
      return renderUser(obj, inflightTools);
    }
    if (obj.type === 'message') {
      return { kind: 'json', text: '' };
    }
    if (obj.type === 'result') {
      const { text, costUsd } = formatResult(obj);
      inflightTools.clear();
      return costUsd === undefined
        ? { kind: 'json', text }
        : { kind: 'json', text, costUsd };
    }

    return { kind: 'json', text: '' };
  };

  return parse;
};

function renderAssistant(
  obj: Record<string, unknown>,
  inflight: Map<string, string>,
): { kind: 'json'; text: string } {
  const content = extractContent(obj);
  if (!content) return { kind: 'json', text: '' };
  const parts: string[] = [];
  for (const block of content) {
    const b = asObject(block);
    if (!b || b.type !== 'tool_use') continue;
    const id = typeof b.id === 'string' ? b.id : '';
    const name = typeof b.name === 'string' ? b.name : 'tool';
    const input = asObject(b.input) ?? {};
    if (id) inflight.set(id, name);
    parts.push(formatToolUse(name, input));
  }
  if (parts.length === 0) return { kind: 'json', text: '' };
  return { kind: 'json', text: `\n${parts.join('\n')}\n` };
}

function renderUser(
  obj: Record<string, unknown>,
  inflight: Map<string, string>,
): { kind: 'json'; text: string } {
  const content = extractContent(obj);
  if (!content) return { kind: 'json', text: '' };
  const parts: string[] = [];
  for (const block of content) {
    const b = asObject(block);
    if (!b || b.type !== 'tool_result') continue;
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
    const original = id ? inflight.get(id) : undefined;
    const label = original === 'Task' ? '[subagent result]' : '[tool result]';
    const body = stringifyToolResultBody(b.content);
    parts.push(`${label} ${truncateInline(body)}`);
  }
  if (parts.length === 0) return { kind: 'json', text: '' };
  return { kind: 'json', text: `\n${parts.join('\n')}\n` };
}

/**
 * Extract the `content` array from either the bare object (`obj.content`) or
 * the wrapped Anthropic message shape (`obj.message.content`). The CLI uses
 * the wrapped form, but tests and older fixtures may use the bare one.
 */
function extractContent(obj: Record<string, unknown>): unknown[] | null {
  const direct = obj.content;
  if (Array.isArray(direct)) return direct;
  const msg = asObject(obj.message);
  if (msg && Array.isArray(msg.content)) return msg.content;
  return null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  if (name === 'Task') {
    const subagent =
      typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
    const desc =
      pickString(input, 'description') ?? pickString(input, 'prompt') ?? '';
    return desc
      ? `[subagent: ${subagent}] ${truncateInline(desc)}`
      : `[subagent: ${subagent}]`;
  }
  const summary = summarizeToolInput(name, input);
  return summary
    ? `[tool: ${name}] ${truncateInline(summary)}`
    : `[tool: ${name}]`;
}

/**
 * Per-tool salient-field heuristics. Falls back to compact JSON of the whole
 * input when no known field matches — so a brand-new tool still renders
 * something useful.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return pickString(input, 'command') ?? compactJson(input);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pickString(input, 'file_path') ?? compactJson(input);
    case 'Grep':
    case 'Glob':
      return pickString(input, 'pattern') ?? compactJson(input);
    case 'WebFetch':
    case 'WebSearch':
      return (
        pickString(input, 'url') ?? pickString(input, 'query') ?? compactJson(input)
      );
    default:
      return compactJson(input);
  }
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyToolResultBody(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = asObject(block);
      if (b && typeof b.text === 'string') texts.push(b.text);
    }
    if (texts.length > 0) return texts.join('\n');
  }
  return compactJson(content);
}

function truncateInline(s: string): string {
  const oneLine = s.replace(/\n/g, '↵');
  if (oneLine.length <= TRUNCATE_AT) return oneLine;
  return `${oneLine.slice(0, TRUNCATE_AT)}…`;
}

/**
 * Render the CLI's terminal `result` event to its annotation line, and — when
 * the frame declares `total_cost_usd` — surface that cost structurally so the
 * runner can feed it to the run-level cost budget. `total_cost_usd` is the
 * cumulative cost for the whole invocation; a negative value is treated as
 * absent so a malformed frame cannot poison the budget accumulator.
 */
function formatResult(obj: Record<string, unknown>): {
  text: string;
  costUsd?: number;
} {
  const parts: string[] = [];
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : 'unknown';
  parts.push(subtype);

  let costUsd: number | undefined;
  const cost = obj.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
    costUsd = cost;
    parts.push(`$${cost.toFixed(4)}`);
  }

  const usage = asObject(obj.usage);
  if (usage) {
    const tin = numericField(usage.input_tokens);
    const tout = numericField(usage.output_tokens);
    if (tin !== null || tout !== null) {
      parts.push(`${formatTokens(tin)} in + ${formatTokens(tout)} out`);
    }
  }

  const dur = obj.duration_ms;
  if (typeof dur === 'number' && Number.isFinite(dur)) {
    parts.push(`${(dur / 1000).toFixed(1)}s`);
  }

  return { text: `\n[result: ${parts.join(' | ')}]\n`, costUsd };
}

function numericField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Returns `?` when missing so partial usage data is still readable. */
function formatTokens(n: number | null): string {
  if (n === null) return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
