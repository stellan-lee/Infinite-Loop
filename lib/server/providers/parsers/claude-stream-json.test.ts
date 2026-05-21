import { beforeEach, describe, expect, it } from 'bun:test';
import { createClaudeStreamJsonParser } from './claude-stream-json';
import type { LineParser } from './index';

describe('claudeStreamJsonParser', () => {
  let claudeStreamJsonParser: LineParser;
  beforeEach(() => {
    claudeStreamJsonParser = createClaudeStreamJsonParser();
  });
  it('emits text from content_block_delta frames', () => {
    const out = claudeStreamJsonParser(
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      }),
    );
    expect(out).toEqual({ kind: 'json', text: 'hello' });
  });

  it('unwraps stream_event wrappers', () => {
    const out = claudeStreamJsonParser(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'x' },
        },
      }),
    );
    expect(out).toEqual({ kind: 'json', text: 'x' });
  });

  it('swallows the rolled-up assistant frame so deltas are not duplicated', () => {
    // The CLI emits this AFTER a sequence of deltas that already streamed the
    // same text. Emitting it again was the bug behind the doubled run-log.
    const out = claudeStreamJsonParser(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello world' }],
        },
      }),
    );
    expect(out).toEqual({ kind: 'json', text: '' });
  });

  it('swallows the rolled-up message frame as well', () => {
    const out = claudeStreamJsonParser(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'rolled-up' }],
      }),
    );
    expect(out).toEqual({ kind: 'json', text: '' });
  });

  it('returns plain for non-JSON lines so the runner can pass them through', () => {
    expect(claudeStreamJsonParser('not json')).toEqual({ kind: 'plain' });
  });

  it('a delta-then-rollup transcript yields the delta text only when joined', () => {
    const lines = [
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi ' },
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'there' },
      }),
      // Rolled-up text-only assistant frame — already streamed via deltas.
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi there' }] },
      }),
    ];
    const joined = lines
      .map((l) => claudeStreamJsonParser(l))
      .filter((r) => r.kind === 'json')
      .map((r) => r.text)
      .join('');
    expect(joined).toBe('Hi there');
  });

  describe('tool_use surfacing', () => {
    it('emits a [tool: <name>] line from the rolled-up assistant frame', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Bash',
                input: { command: 'ls -la', description: 'list' },
              },
            ],
          },
        }),
      );
      expect(out.kind).toBe('json');
      if (out.kind === 'json') {
        expect(out.text).toContain('[tool: Bash]');
        expect(out.text).toContain('ls -la');
        expect(out.text.startsWith('\n')).toBe(true);
        expect(out.text.endsWith('\n')).toBe(true);
      }
    });

    it('formats a Task tool_use as a subagent boundary', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_t1',
                name: 'Task',
                input: {
                  subagent_type: 'code-review-agent',
                  description: 'Review auth changes',
                  prompt: 'long prompt text...',
                },
              },
            ],
          },
        }),
      );
      expect(out.kind).toBe('json');
      if (out.kind === 'json') {
        expect(out.text).toContain('[subagent: code-review-agent]');
        expect(out.text).toContain('Review auth changes');
      }
    });

    it('picks a salient field per known tool (Read uses file_path)', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_r1',
                name: 'Read',
                input: { file_path: '/tmp/foo.ts' },
              },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[tool: Read]');
        expect(out.text).toContain('/tmp/foo.ts');
      }
    });

    it('mixes text + tool_use in one assistant frame, emitting only the tool line', () => {
      // Text was already streamed via deltas; only the tool_use is new info.
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I will run a command.' },
              {
                type: 'tool_use',
                id: 'toolu_2',
                name: 'Bash',
                input: { command: 'pwd' },
              },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[tool: Bash]');
        expect(out.text).not.toContain('I will run a command.');
      }
    });

    it('truncates long tool input to a single line, ≤200 chars of payload', () => {
      const long = 'x'.repeat(500);
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_3',
                name: 'Bash',
                input: { command: `echo ${long}` },
              },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        // Single line.
        expect(out.text.trim().includes('\n')).toBe(false);
        // Payload portion bounded.
        expect(out.text.length).toBeLessThan(260);
        expect(out.text).toMatch(/…\n?$/);
      }
    });

    it('collapses newlines in tool input to ↵', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_4',
                name: 'Bash',
                input: { command: 'line1\nline2' },
              },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('line1↵line2');
      }
    });
  });

  describe('tool_result surfacing', () => {
    it('emits [tool result] for a non-Task tool_use_id seen earlier', () => {
      claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        }),
      );
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: 'file1.txt\nfile2.txt',
              },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[tool result]');
        expect(out.text).toContain('file1.txt');
      }
    });

    it('emits [subagent result] when the original tool_use was Task', () => {
      claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_t9',
                name: 'Task',
                input: { subagent_type: 'planner', description: 'Plan it' },
              },
            ],
          },
        }),
      );
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_t9',
                content: [{ type: 'text', text: 'Plan looks good.' }],
              },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[subagent result]');
        expect(out.text).toContain('Plan looks good.');
      }
    });

    it('falls back to [tool result] when id is unknown', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'unknown', content: 'orphan' },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[tool result]');
        expect(out.text).toContain('orphan');
      }
    });
  });

  describe('final result summary', () => {
    it('formats subtype, cost, tokens, and duration', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          duration_ms: 47230,
          total_cost_usd: 0.0412,
          usage: { input_tokens: 12345, output_tokens: 678 },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[result: success');
        expect(out.text).toContain('$0.0412');
        expect(out.text).toContain('12.3k in');
        expect(out.text).toContain('678 out');
        expect(out.text).toContain('47.2s');
      }
    });

    it('omits missing fields gracefully', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[result: error_max_turns');
      }
    });

    it('surfaces total_cost_usd structurally as costUsd', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.0412,
        }),
      );
      expect(out.kind).toBe('json');
      if (out.kind === 'json') expect(out.costUsd).toBe(0.0412);
    });

    it('leaves costUsd undefined when the frame declares no cost', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({ type: 'result', subtype: 'success' }),
      );
      if (out.kind === 'json') expect(out.costUsd).toBeUndefined();
    });

    it('ignores a negative total_cost_usd', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          total_cost_usd: -1,
        }),
      );
      if (out.kind === 'json') expect(out.costUsd).toBeUndefined();
    });

    it('propagates costUsd through a stream_event-wrapped result', () => {
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'result', subtype: 'success', total_cost_usd: 0.5 },
        }),
      );
      if (out.kind === 'json') expect(out.costUsd).toBe(0.5);
    });

    it('clears in-flight tool_use ids so subsequent runs do not leak state', () => {
      claudeStreamJsonParser(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_leak',
                name: 'Task',
                input: { subagent_type: 'foo' },
              },
            ],
          },
        }),
      );
      claudeStreamJsonParser(JSON.stringify({ type: 'result', subtype: 'success' }));
      // After result: same id should now resolve to the [tool result] fallback,
      // proving the map was cleared.
      const out = claudeStreamJsonParser(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_leak', content: 'x' },
            ],
          },
        }),
      );
      if (out.kind === 'json') {
        expect(out.text).toContain('[tool result]');
        expect(out.text).not.toContain('[subagent result]');
      }
    });
  });
});
