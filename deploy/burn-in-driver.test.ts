import { describe, expect, it } from 'bun:test';
import {
  evaluatePhase33,
  isBudgetFailure,
  parseArgs,
  readMetric,
  UsageError,
  type Phase33Observations,
} from './burn-in-driver';

/*
 * Unit coverage for the burn-in driver's pure helpers — argument parsing,
 * metric extraction, failure classification, and the Phase 3.3 verdict.
 *
 * The driver itself drives a live stack and is exercised by hand during a
 * burn-in; these are the parts with real logic that a bug would silently
 * misreport (a misparsed metric or a wrong verdict would mark Phase 3.3
 * passed when it was not). The network-touching code is intentionally not
 * unit-tested here — it is the burn-in's job to run it against the real app.
 */

describe('parseArgs', () => {
  it('applies the documented defaults', () => {
    const o = parseArgs([]);
    expect(o.baseUrl).toBe('http://localhost:8080');
    expect(o.maxRuns).toBe(200);
    expect(o.confirmSpend).toBe(false);
    expect(o.preflightOnly).toBe(false);
    expect(o.pollTimeoutMs).toBe(240_000);
    expect(o.tokenFromArg).toBeUndefined();
    expect(o.prometheusUrl).toBeUndefined();
    expect(o.workflowPath).toBeUndefined();
  });

  it('parses value flags and strips trailing slashes from URLs', () => {
    const o = parseArgs([
      '--base-url', 'http://host:3000/',
      '--token', 'secret',
      '--prometheus', 'http://prom:9090//',
      '--max-runs', '12',
      '--prompt', 'hello world',
      '--poll-timeout', '30',
    ]);
    expect(o.baseUrl).toBe('http://host:3000');
    expect(o.tokenFromArg).toBe('secret');
    expect(o.prometheusUrl).toBe('http://prom:9090');
    expect(o.maxRuns).toBe(12);
    expect(o.promptOverride).toBe('hello world');
    expect(o.pollTimeoutMs).toBe(30_000);
  });

  it('parses boolean flags', () => {
    const o = parseArgs(['--confirm-spend', '--preflight-only']);
    expect(o.confirmSpend).toBe(true);
    expect(o.preflightOnly).toBe(true);
  });

  it('floors a fractional --max-runs', () => {
    expect(parseArgs(['--max-runs', '5.9']).maxRuns).toBe(5);
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--token'])).toThrow(UsageError);
    expect(() => parseArgs(['--token', '--confirm-spend'])).toThrow(UsageError);
  });

  it('rejects a non-positive numeric flag', () => {
    expect(() => parseArgs(['--max-runs', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['--max-runs', 'abc'])).toThrow(UsageError);
    expect(() => parseArgs(['--poll-timeout', '-5'])).toThrow(UsageError);
  });

  it('treats --help as a UsageError', () => {
    expect(() => parseArgs(['--help'])).toThrow(UsageError);
    expect(() => parseArgs(['-h'])).toThrow(UsageError);
  });
});

describe('readMetric', () => {
  const exposition = [
    '# HELP infloop_cost_budget_spent_usd Cumulative cost.',
    '# TYPE infloop_cost_budget_spent_usd gauge',
    'infloop_cost_budget_spent_usd 0.4231',
    '# TYPE infloop_cost_budget_limit_usd gauge',
    'infloop_cost_budget_limit_usd 0.5',
    '# TYPE infloop_runs_total counter',
    'infloop_runs_total{status="succeeded"} 7',
    'infloop_runs_total{status="failed"} 1',
    '',
  ].join('\n');

  it('reads an unlabeled gauge', () => {
    expect(readMetric(exposition, 'infloop_cost_budget_spent_usd')).toBe(0.4231);
    expect(readMetric(exposition, 'infloop_cost_budget_limit_usd')).toBe(0.5);
  });

  it('returns undefined for a metric that is absent', () => {
    expect(readMetric(exposition, 'infloop_missing')).toBeUndefined();
  });

  it('does not match a labeled series as an unlabeled metric', () => {
    // `infloop_runs_total` only appears with a {status="..."} label here.
    expect(readMetric(exposition, 'infloop_runs_total')).toBeUndefined();
  });

  it('reads a zero value', () => {
    expect(readMetric('infloop_cost_budget_limit_usd 0\n', 'infloop_cost_budget_limit_usd'))
      .toBe(0);
  });
});

describe('isBudgetFailure', () => {
  it('matches the mid-run cost-budget abort message', () => {
    expect(
      isBudgetFailure(
        'run aborted: process-wide cost budget exceeded ($0.5). Cumulative ' +
          'provider cost across all runs since startup reached $0.5130.',
      ),
    ).toBe(true);
  });

  it('does not match an unrelated provider failure', () => {
    expect(isBudgetFailure('agent node failed: command not found: claude')).toBe(false);
  });

  it('handles a missing message', () => {
    expect(isBudgetFailure(undefined)).toBe(false);
  });
});

describe('evaluatePhase33', () => {
  const allObserved: Phase33Observations = {
    limitUsd: 0.5,
    baselineSpentUsd: 0,
    finalSpentUsd: 0.513,
    runsExecuted: 17,
    sawNearLimit: true,
    sawExhausted: true,
    midRunTrip: true,
    saw503: true,
  };

  it('passes when every cost-budget behaviour was observed', () => {
    const { checks, allPass } = evaluatePhase33(allObserved);
    expect(allPass).toBe(true);
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it('fails when the admission gate never returned 503', () => {
    const { allPass, checks } = evaluatePhase33({ ...allObserved, saw503: false });
    expect(allPass).toBe(false);
    const gate = checks.find((c) => c.label.includes('503'));
    expect(gate?.pass).toBe(false);
  });

  it('fails the costed-runs check when spend never rose', () => {
    const { allPass, checks } = evaluatePhase33({
      ...allObserved,
      finalSpentUsd: 0,
      runsExecuted: 0,
      sawNearLimit: false,
      sawExhausted: false,
      midRunTrip: false,
      saw503: false,
    });
    expect(allPass).toBe(false);
    expect(checks[0].pass).toBe(false);
  });

  it('fails when no mid-run trip was observed', () => {
    const { allPass } = evaluatePhase33({ ...allObserved, midRunTrip: false });
    expect(allPass).toBe(false);
  });
});
