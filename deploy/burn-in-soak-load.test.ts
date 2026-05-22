import { describe, expect, it } from 'bun:test';
import {
  emptyTally,
  parseArgs,
  summarizeLoad,
  UsageError,
  type LoadTally,
} from './burn-in-soak-load';

/*
 * Unit coverage for the soak-load generator's pure helpers — argument parsing
 * and the load-run summary verdict.
 *
 * As with burn-in-driver.test.ts and burn-in-soak-watch.test.ts, the network-
 * touching code is intentionally not unit-tested here — driving it against a
 * live stack is the burn-in's job. These are the parts with real logic a bug
 * would silently misreport: a wrong verdict would mark a soak load delivered
 * when it drove nothing, leaving the paired soak-watch run to pass vacuously.
 */

describe('parseArgs', () => {
  it('applies the documented defaults', () => {
    const o = parseArgs([]);
    expect(o.baseUrl).toBe('http://localhost:8080');
    expect(o.intervalMs).toBe(180_000);
    expect(o.durationMs).toBe(0);
    expect(o.concurrency).toBe(1);
    expect(o.tokenFromArg).toBeUndefined();
    expect(o.triggerId).toBeUndefined();
    expect(o.workflowPath).toBeUndefined();
  });

  it('parses value flags and strips trailing slashes from the base URL', () => {
    const o = parseArgs([
      '--base-url', 'http://host:3000/',
      '--token', 'secret',
      '--interval', '5',
      '--duration', '1.5',
      '--concurrency', '20',
      '--trigger-id', 'abc123',
      '--workflow', '/tmp/wf.json',
    ]);
    expect(o.baseUrl).toBe('http://host:3000');
    expect(o.tokenFromArg).toBe('secret');
    expect(o.intervalMs).toBe(5_000);
    expect(o.durationMs).toBe(5_400_000);
    expect(o.concurrency).toBe(20);
    expect(o.triggerId).toBe('abc123');
    expect(o.workflowPath).toBe('/tmp/wf.json');
  });

  it('accepts a fractional --interval for flooding', () => {
    expect(parseArgs(['--interval', '0.2']).intervalMs).toBeCloseTo(200);
  });

  it('accepts --duration 0 as "run until Ctrl-C"', () => {
    expect(parseArgs(['--duration', '0']).durationMs).toBe(0);
  });

  it('floors a fractional --concurrency', () => {
    expect(parseArgs(['--concurrency', '4.9']).concurrency).toBe(4);
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--token'])).toThrow(UsageError);
    expect(() => parseArgs(['--token', '--interval'])).toThrow(UsageError);
  });

  it('rejects a non-positive --interval and --concurrency', () => {
    expect(() => parseArgs(['--interval', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['--interval', 'abc'])).toThrow(UsageError);
    expect(() => parseArgs(['--concurrency', '0'])).toThrow(UsageError);
  });

  it('rejects a negative --duration but allows zero', () => {
    expect(() => parseArgs(['--duration', '-1'])).toThrow(UsageError);
    expect(parseArgs(['--duration', '0']).durationMs).toBe(0);
  });

  it('treats --help as a UsageError', () => {
    expect(() => parseArgs(['--help'])).toThrow(UsageError);
    expect(() => parseArgs(['-h'])).toThrow(UsageError);
  });
});

/* ── summarizeLoad ──────────────────────────────────────────────────────── */

/** A steady, modest Phase 5 run: every delivery accepted, queue near empty. */
function steadyRun(): LoadTally {
  return {
    ...emptyTally(),
    waves: 240,
    fired: 240,
    accepted: 240,
    metricSamples: 240,
    peakQueueDepth: 1,
  };
}

describe('summarizeLoad', () => {
  it('passes a clean steady run — load delivered, queue stayed shallow', () => {
    const r = summarizeLoad(steadyRun());
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.severity === 'fail')).toBe(false);
    const delivered = r.findings.find((f) => f.label === 'Webhook load delivered');
    expect(delivered?.severity).toBe('pass');
  });

  it('fails when no delivery was ever accepted (a vacuous soak)', () => {
    const t: LoadTally = {
      ...emptyTally(),
      waves: 10,
      fired: 10,
      otherStatus: 10,
      metricSamples: 10,
    };
    const r = summarizeLoad(t);
    expect(r.ok).toBe(false);
    const delivered = r.findings.find((f) => f.label === 'Webhook load delivered');
    expect(delivered?.severity).toBe('fail');
  });

  it('fails when transport errors dominate the run', () => {
    const t: LoadTally = {
      ...emptyTally(),
      waves: 100,
      fired: 100,
      accepted: 5,
      transportErrors: 95,
      metricSamples: 5,
    };
    const r = summarizeLoad(t);
    expect(r.ok).toBe(false);
    const transport = r.findings.find((f) => f.label === 'Transport reliability');
    expect(transport?.severity).toBe('fail');
  });

  it('does not fail on back-pressure — 503/429 are deliberate, not errors', () => {
    // A deliberate flood: lots of 503/429, but real load still landed and the
    // transport layer was fine. That is a healthy flood, not a failed run.
    const t: LoadTally = {
      ...emptyTally(),
      waves: 50,
      fired: 5000,
      accepted: 200,
      queueFull: 4500,
      rateLimited: 300,
      metricSamples: 50,
      peakQueueDepth: 100,
      samplesOverBacklog: 40,
    };
    const r = summarizeLoad(t);
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.severity === 'fail')).toBe(false);
  });

  it('reports the backlog threshold being crossed', () => {
    const t: LoadTally = {
      ...emptyTally(),
      waves: 50,
      fired: 5000,
      accepted: 200,
      queueFull: 4800,
      metricSamples: 50,
      peakQueueDepth: 100,
      samplesOverBacklog: 40,
    };
    const depth = summarizeLoad(t).findings.find(
      (f) => f.label === 'Trigger-queue depth',
    );
    expect(depth?.severity).toBe('info');
    expect(depth?.detail).toContain('InfiniteLoopTriggerQueueBacklog');
  });

  it('notes a shallow queue under a steady Phase 5 load', () => {
    const depth = summarizeLoad(steadyRun()).findings.find(
      (f) => f.label === 'Trigger-queue depth',
    );
    expect(depth?.severity).toBe('info');
    expect(depth?.detail).toContain('steady');
  });

  it('reports queue depth as unobserved when every scrape failed', () => {
    const t: LoadTally = { ...emptyTally(), waves: 10, fired: 10, accepted: 10 };
    const depth = summarizeLoad(t).findings.find(
      (f) => f.label === 'Trigger-queue depth',
    );
    expect(depth?.detail).toContain('not observed');
  });
});
