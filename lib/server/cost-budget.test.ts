import { afterEach, describe, expect, it } from 'bun:test';
import { GlobalCostBudget, resolveCostCeiling } from './cost-budget';

/*
 * GlobalCostBudget — process-wide cumulative cost ceiling.
 *
 * These tests pin the pure budget accounting; the workflow-engine suite proves
 * a real run trips on it mid-flight and trigger-queue-singleton proves
 * engineStartAdapter refuses admission when it is exhausted.
 */

describe('GlobalCostBudget — accumulation', () => {
  it('starts at zero spend', () => {
    expect(new GlobalCostBudget({ ceilingUsd: 10 }).spent).toBe(0);
  });

  it('accumulates each reported cost into the running total', () => {
    const b = new GlobalCostBudget({ ceilingUsd: 10 });
    b.add(1.25);
    b.add(0.75);
    expect(b.spent).toBeCloseTo(2, 6);
  });

  it('ignores malformed costs so the accumulator cannot be poisoned', () => {
    const b = new GlobalCostBudget({ ceilingUsd: 10 });
    // A NaN would make every later `exceeded()` comparison false and silently
    // disable the ceiling; 0 / negative are nonsensical as a cost increment.
    b.add(NaN);
    b.add(Infinity);
    b.add(-3);
    b.add(0);
    b.add(2);
    expect(b.spent).toBe(2);
  });

  it('reset() drops cumulative spend back to zero', () => {
    const b = new GlobalCostBudget({ ceilingUsd: 10 });
    b.add(5);
    b.reset();
    expect(b.spent).toBe(0);
  });
});

describe('GlobalCostBudget — exceeded()', () => {
  it('is false while spend stays at or below the ceiling', () => {
    const b = new GlobalCostBudget({ ceilingUsd: 5 });
    b.add(4.99);
    expect(b.exceeded()).toBe(false);
    // Exactly at the ceiling is not over it — matches the per-run cost cap's
    // strict `>` comparison.
    b.add(0.01);
    expect(b.spent).toBeCloseTo(5, 6);
    expect(b.exceeded()).toBe(false);
  });

  it('is true once spend passes the ceiling', () => {
    const b = new GlobalCostBudget({ ceilingUsd: 5 });
    b.add(5.01);
    expect(b.exceeded()).toBe(true);
  });

  it('is always false when the ceiling is disabled (0)', () => {
    const b = new GlobalCostBudget({ ceilingUsd: 0 });
    b.add(1_000_000);
    // A 0 ceiling means "no ceiling" — no amount of spend trips it.
    expect(b.exceeded()).toBe(false);
  });
});

describe('resolveCostCeiling', () => {
  const saved = process.env.INFLOOP_MAX_TOTAL_COST_USD;
  afterEach(() => {
    if (saved === undefined) delete process.env.INFLOOP_MAX_TOTAL_COST_USD;
    else process.env.INFLOOP_MAX_TOTAL_COST_USD = saved;
  });

  it('defaults to 0 (disabled) when the env var is unset', () => {
    delete process.env.INFLOOP_MAX_TOTAL_COST_USD;
    expect(resolveCostCeiling()).toBe(0);
  });

  it('honors a valid positive override, including fractional dollars', () => {
    process.env.INFLOOP_MAX_TOTAL_COST_USD = '25';
    expect(resolveCostCeiling()).toBe(25);
    process.env.INFLOOP_MAX_TOTAL_COST_USD = '2.5';
    expect(resolveCostCeiling()).toBe(2.5);
  });

  it('treats a literal 0 as a meaningful "disabled" value', () => {
    process.env.INFLOOP_MAX_TOTAL_COST_USD = '0';
    expect(resolveCostCeiling()).toBe(0);
  });

  it('falls back to 0 for a non-numeric, negative or empty override', () => {
    for (const bad of ['abc', '-5', '']) {
      process.env.INFLOOP_MAX_TOTAL_COST_USD = bad;
      expect(resolveCostCeiling()).toBe(0);
    }
  });
});
