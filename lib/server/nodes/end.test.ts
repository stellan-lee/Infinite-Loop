import { describe, expect, it } from 'bun:test';
import type { NodeExecutorContext } from '../../shared/workflow';
import { endExecutor } from './end';

function context(outputs: Record<string, string>, scope: NodeExecutorContext['scope']): NodeExecutorContext {
  return { config: { outputs }, scope, defaultCwd: '/tmp', signal: new AbortController().signal };
}

describe('End selected outputs', () => {
  it('copies typed values from dotted scope paths and marks unavailable values null', async () => {
    const scope = {
      source: { result: { count: 3, ok: false, items: [1, 2], missing: null } },
    };
    const result = await endExecutor.execute(context({
      count: 'source.result.count',
      ok: 'source.result.ok',
      items: 'source.result.items',
      missing: 'source.result.missing',
      absent: 'source.result.nope',
    }, scope));
    expect(result).toEqual({
      branch: 'next',
      outputs: { count: 3, ok: false, items: [1, 2], missing: null, absent: null },
    });
  });

  it('ignores inherited properties when walking the path', async () => {
    const inherited = Object.create({ secret: 'inherited' }) as Record<string, unknown>;
    const result = await endExecutor.execute(context({ exposed: 'source.secret' }, { source: inherited }));
    expect(result.outputs).toEqual({ exposed: null });
  });
});
