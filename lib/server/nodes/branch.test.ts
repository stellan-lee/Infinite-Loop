import { describe, expect, it } from 'bun:test';
import type { BranchConfig, NodeExecutorContext } from '../../shared/workflow';
import { branchExecutor } from './branch';

function makeCtx(config: unknown): NodeExecutorContext {
  return {
    config,
    scope: {},
    defaultCwd: '/tmp',
    signal: new AbortController().signal,
  };
}

describe('branchExecutor', () => {
  it('== equal operands → branch "true", result echoed in outputs', async () => {
    const cfg: BranchConfig = { lhs: 'a', op: '==', rhs: 'a' };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('true');
    expect(result.outputs.result).toBe(true);
    expect(result.outputs).toMatchObject({ lhs: 'a', op: '==', rhs: 'a' });
  });

  it('== unequal operands → branch "false"', async () => {
    const cfg: BranchConfig = { lhs: 'a', op: '==', rhs: 'b' };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('false');
    expect(result.outputs.result).toBe(false);
  });

  it('!= unequal operands → branch "true"', async () => {
    const cfg: BranchConfig = { lhs: 'a', op: '!=', rhs: 'b' };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('true');
  });

  it('contains: rhs is a substring of lhs → branch "true"', async () => {
    const cfg: BranchConfig = {
      lhs: 'hello world',
      op: 'contains',
      rhs: 'world',
    };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('true');
  });

  it('contains: rhs absent from lhs → branch "false"', async () => {
    const cfg: BranchConfig = { lhs: 'hello', op: 'contains', rhs: 'XYZ' };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('false');
  });

  it('matches: valid regex that hits → branch "true"', async () => {
    const cfg: BranchConfig = {
      lhs: 'order-42',
      op: 'matches',
      rhs: '^order-\\d+$',
    };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('true');
  });

  it('matches: valid regex that misses → branch "false"', async () => {
    const cfg: BranchConfig = {
      lhs: 'order-x',
      op: 'matches',
      rhs: '^order-\\d+$',
    };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('false');
  });

  it('caseInsensitive: == ignores case → branch "true"', async () => {
    const cfg: BranchConfig = {
      lhs: 'HELLO',
      op: '==',
      rhs: 'hello',
      caseInsensitive: true,
    };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('true');
  });

  it('matches: invalid regex → branch "error" with detail and operands', async () => {
    const cfg: BranchConfig = { lhs: 'x', op: 'matches', rhs: '[' };
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('error');
    expect(String(result.outputs.error)).toContain('invalid regex');
    expect(result.outputs).toMatchObject({ lhs: 'x', op: 'matches', rhs: '[' });
  });

  it('non-object config → branch "error" with "invalid branch config"', async () => {
    const result = await branchExecutor.execute(makeCtx(null));
    expect(result.branch).toBe('error');
    expect(result.outputs.error).toBe('invalid branch config');
  });

  it('missing operand → branch "error"', async () => {
    const cfg = { op: '==', rhs: 'a' } as unknown as BranchConfig;
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('error');
    expect(result.outputs.error).toBe('invalid branch config');
  });

  it('unknown operator → branch "error"', async () => {
    const cfg = { lhs: 'a', op: '>=', rhs: 'b' } as unknown as BranchConfig;
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('error');
    expect(result.outputs.error).toBe('invalid branch config');
  });

  it('non-boolean caseInsensitive → branch "error"', async () => {
    const cfg = {
      lhs: 'a',
      op: '==',
      rhs: 'a',
      caseInsensitive: 'yes',
    } as unknown as BranchConfig;
    const result = await branchExecutor.execute(makeCtx(cfg));
    expect(result.branch).toBe('error');
    expect(result.outputs.error).toBe('invalid branch config');
  });
});
