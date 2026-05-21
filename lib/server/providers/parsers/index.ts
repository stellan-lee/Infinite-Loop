/*
 * Output-format → line parser registry.
 *
 * Provider JSON files declare `outputFormat: <key>` to pick a parser; the key
 * MUST be one of `KNOWN_OUTPUT_FORMATS` below. Adding a provider that reuses
 * an existing format = pure JSON. A provider with a brand-new output shape
 * gets a small parser file here plus an entry in `parserFactories`.
 *
 * Factories, not parsers: each provider invocation gets its own parser
 * instance via `factory()`. Parsers that need per-run state (e.g. the
 * claude-stream-json parser tracking in-flight tool_use_ids) keep that
 * state in a closure, so parallel agent branches in the same process do
 * not corrupt each other.
 *
 * Known formats:
 *  - "claude-stream-json" — Anthropic Messages stream-json (text + tool calls,
 *    tool results, and final result summary as annotation lines)
 *  - "plain"              — every stdout line emitted verbatim
 */

import { createClaudeStreamJsonParser } from './claude-stream-json';
import { createPlainParser } from './plain';

/**
 * `costUsd` (json variant only) carries a provider-reported cumulative cost
 * for the invocation, when the line is a result/summary frame that declares
 * one. It is optional and absent on every other line; the runner takes the
 * last value seen as the invocation's total (see `runCliProvider`).
 */
export type LineParseResult =
  | { kind: 'json'; text: string; costUsd?: number }
  | { kind: 'plain' };
export type LineParser = (line: string) => LineParseResult;
export type LineParserFactory = () => LineParser;

export const parserFactories: Record<string, LineParserFactory> = {
  'claude-stream-json': createClaudeStreamJsonParser,
  plain: createPlainParser,
};

export const KNOWN_OUTPUT_FORMATS = Object.keys(parserFactories);
