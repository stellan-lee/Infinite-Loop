import { describe, expect, it } from 'bun:test';
import {
  analyzeSoak,
  parseArgs,
  parseDockerMem,
  UsageError,
  type SoakSample,
} from './burn-in-soak-watch';

/*
 * Unit coverage for the soak-watch driver's pure helpers — argument parsing,
 * docker-stats memory parsing, and the Phase 5 drift verdict.
 *
 * As with burn-in-driver.test.ts, the network- and docker-touching code is
 * intentionally not unit-tested here — exercising it against a live stack is
 * the burn-in's job. These are the parts with real logic that a bug would
 * silently misreport: a wrong verdict would mark a soak passed when memory was
 * leaking or the process had silently restarted.
 */

describe('parseArgs', () => {
  it('applies the documented defaults', () => {
    const o = parseArgs([]);
    expect(o.baseUrl).toBe('http://localhost:8080');
    expect(o.intervalMs).toBe(300_000);
    expect(o.durationMs).toBe(0);
    expect(o.rssGrowthThreshold).toBeCloseTo(0.1);
    expect(o.tokenFromArg).toBeUndefined();
    expect(o.dockerContainer).toBeUndefined();
    expect(o.outPath).toBeUndefined();
  });

  it('parses value flags and strips trailing slashes from the base URL', () => {
    const o = parseArgs([
      '--base-url', 'http://host:3000/',
      '--token', 'secret',
      '--interval', '60',
      '--duration', '1.5',
      '--docker-container', 'infinite-loop',
      '--rss-growth-threshold', '25',
      '--out', '/tmp/soak.jsonl',
    ]);
    expect(o.baseUrl).toBe('http://host:3000');
    expect(o.tokenFromArg).toBe('secret');
    expect(o.intervalMs).toBe(60_000);
    expect(o.durationMs).toBe(5_400_000);
    expect(o.dockerContainer).toBe('infinite-loop');
    expect(o.rssGrowthThreshold).toBeCloseTo(0.25);
    expect(o.outPath).toBe('/tmp/soak.jsonl');
  });

  it('accepts --duration 0 as "run until Ctrl-C"', () => {
    expect(parseArgs(['--duration', '0']).durationMs).toBe(0);
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--token'])).toThrow(UsageError);
    expect(() => parseArgs(['--token', '--interval'])).toThrow(UsageError);
  });

  it('rejects a non-positive --interval and a non-positive threshold', () => {
    expect(() => parseArgs(['--interval', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['--interval', 'abc'])).toThrow(UsageError);
    expect(() => parseArgs(['--rss-growth-threshold', '0'])).toThrow(UsageError);
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

describe('parseDockerMem', () => {
  it('parses the used half of a binary-unit MemUsage field', () => {
    expect(parseDockerMem('45.2MiB / 1.952GiB')).toBeCloseTo(45.2 * 1024 ** 2);
    expect(parseDockerMem('1.5GiB / 2GiB')).toBeCloseTo(1.5 * 1024 ** 3);
    expect(parseDockerMem('512KiB / 1GiB')).toBe(512 * 1024);
  });

  it('reads a zero reading', () => {
    expect(parseDockerMem('0B / 1.952GiB')).toBe(0);
  });

  it('tolerates decimal (SI) units', () => {
    expect(parseDockerMem('100MB / 1GB')).toBeCloseTo(100 * 1000 ** 2);
  });

  it('returns undefined for an unparseable field', () => {
    expect(parseDockerMem('garbage')).toBeUndefined();
    expect(parseDockerMem('')).toBeUndefined();
    expect(parseDockerMem('MiB / 1GiB')).toBeUndefined();
    expect(parseDockerMem('45.2ZiB / 1GiB')).toBeUndefined();
  });
});

/* ── analyzeSoak ────────────────────────────────────────────────────────── */

/** Build one zero-everything sample, climbing uptime, overridable per field. */
function mkSample(i: number, over: Partial<SoakSample> = {}): SoakSample {
  return {
    t: 1_000_000 + i * 300_000,
    uptimeSeconds: 100 + i * 300,
    spentUsd: 0,
    gauges: {
      runs_active: 0,
      queue_depth: 0,
      event_buffer_events: 0,
      slot_pool_in_use: 0,
      slot_pool_waiting: 0,
    },
    ...over,
  };
}

/** A run long enough (36 samples) for the early/late-third trend checks. */
function cleanRun(): SoakSample[] {
  return Array.from({ length: 36 }, (_, i) => mkSample(i));
}

const THRESHOLD = { rssGrowthThreshold: 0.1 };

describe('analyzeSoak', () => {
  it('passes a clean run — uptime climbs, every gauge floor steady', () => {
    const r = analyzeSoak(cleanRun(), THRESHOLD);
    expect(r.ok).toBe(true);
    expect(r.trendAssessed).toBe(true);
    expect(r.findings.some((f) => f.severity === 'fail')).toBe(false);
    // RSS was never sampled — reported as info, not a failure.
    const rss = r.findings.find((f) => f.label.startsWith('RSS'));
    expect(rss?.severity).toBe('info');
  });

  it('fails when uptime regresses (a silent restart)', () => {
    const samples = cleanRun();
    samples[20] = mkSample(20, { uptimeSeconds: 5 }); // process restarted
    const r = analyzeSoak(samples, THRESHOLD);
    expect(r.ok).toBe(false);
    const uptime = r.findings.find((f) => f.label.includes('Uptime'));
    expect(uptime?.severity).toBe('fail');
  });

  it('does not flag a sub-grace uptime dip from scrape rounding', () => {
    const samples = cleanRun();
    // A 3s dip — within UPTIME_REGRESSION_GRACE_S — must not read as a restart.
    samples[15] = mkSample(15, { uptimeSeconds: samples[14].uptimeSeconds - 3 });
    const r = analyzeSoak(samples, THRESHOLD);
    const uptime = r.findings.find((f) => f.label.includes('Uptime'));
    expect(uptime?.severity).toBe('pass');
  });

  it('fails when a return-to-baseline gauge ratchets up', () => {
    const samples = cleanRun();
    // The late third never drains event_buffer_events back to its floor.
    for (let i = 24; i < 36; i++) {
      samples[i] = mkSample(i, {
        gauges: { ...mkSample(i).gauges, event_buffer_events: 7 },
      });
    }
    const r = analyzeSoak(samples, THRESHOLD);
    expect(r.ok).toBe(false);
    const gauge = r.findings.find((f) => f.label.startsWith('event_buffer_events'));
    expect(gauge?.severity).toBe('fail');
  });

  it('fails when the RSS post-GC floor trends past the threshold', () => {
    const samples = cleanRun().map((s, i) =>
      mkSample(i, { rssBytes: (i < 18 ? 100 : 130) * 1024 ** 2 }),
    );
    const r = analyzeSoak(samples, THRESHOLD);
    expect(r.ok).toBe(false);
    const rss = r.findings.find((f) => f.label.startsWith('RSS'));
    expect(rss?.severity).toBe('fail');
  });

  it('passes RSS within the growth threshold', () => {
    const samples = cleanRun().map((s, i) =>
      mkSample(i, { rssBytes: (i < 18 ? 100 : 105) * 1024 ** 2 }),
    );
    const rss = analyzeSoak(samples, THRESHOLD).findings.find((f) =>
      f.label.startsWith('RSS'),
    );
    expect(rss?.severity).toBe('pass');
  });

  it('never reports RSS pass when the early-third floor reads 0 (glitch)', () => {
    // A 0B docker-stats reading must not let a later multi-MiB RSS slip
    // through as "0% growth" — the leak this tool exists to catch.
    const samples = cleanRun().map((s, i) =>
      mkSample(i, { rssBytes: i < 18 ? 0 : 200 * 1024 ** 2 }),
    );
    const rss = analyzeSoak(samples, THRESHOLD).findings.find((f) =>
      f.label.startsWith('RSS'),
    );
    expect(rss?.severity).not.toBe('pass');
    expect(rss?.severity).toBe('info');
  });

  it('ignores a single spurious 0B RSS reading when computing the floor', () => {
    // One glitched 0 among healthy readings must not poison the leak check.
    const samples = cleanRun().map((s, i) =>
      mkSample(i, { rssBytes: (i < 18 ? 100 : 105) * 1024 ** 2 }),
    );
    samples[3] = mkSample(3, { rssBytes: 0 }); // glitch in the early third
    const rss = analyzeSoak(samples, THRESHOLD).findings.find((f) =>
      f.label.startsWith('RSS'),
    );
    expect(rss?.severity).toBe('pass');
  });

  it('assesses the trend at exactly MIN_SAMPLES_FOR_TREND samples', () => {
    const samples = Array.from({ length: 30 }, (_, i) => mkSample(i));
    expect(analyzeSoak(samples, THRESHOLD).trendAssessed).toBe(true);
  });

  it('reports the trend inconclusive for a short run but still checks uptime', () => {
    const short = Array.from({ length: 10 }, (_, i) => mkSample(i));
    const r = analyzeSoak(short, THRESHOLD);
    expect(r.trendAssessed).toBe(false);
    expect(r.ok).toBe(true); // nothing failed — uptime is clean
    // No per-gauge findings when the trend is not assessed.
    expect(r.findings.some((f) => f.label.startsWith('event_buffer_events'))).toBe(
      false,
    );
    expect(r.findings.some((f) => f.label.includes('Uptime'))).toBe(true);
  });

  it('cannot assess uptime with fewer than two samples', () => {
    const r = analyzeSoak([mkSample(0)], THRESHOLD);
    const uptime = r.findings.find((f) => f.label.includes('Uptime'));
    expect(uptime?.severity).toBe('info');
  });
});
