import { afterEach, describe, expect, it } from 'bun:test';
import { EventMemoryBudget, resolveTotalEventCap } from './event-memory-budget';

/*
 * EventMemoryBudget — fair-share accounting for the process-wide event buffer.
 *
 * These tests pin the pure budget math; run-controller-buffer.test.ts proves
 * a real RunController honors the share it hands out.
 */

describe('EventMemoryBudget — participant accounting', () => {
  it('tracks live participants via register / unregister', () => {
    const b = new EventMemoryBudget({ totalCap: 10_000 });
    expect(b.activeRuns).toBe(0);
    b.register();
    b.register();
    expect(b.activeRuns).toBe(2);
    b.unregister();
    expect(b.activeRuns).toBe(1);
  });

  it('never lets the participant count go negative', () => {
    const b = new EventMemoryBudget({ totalCap: 10_000 });
    // An unbalanced unregister must not drive the count below zero — a
    // negative divisor would inflate every later fair share.
    b.unregister();
    b.unregister();
    expect(b.activeRuns).toBe(0);
    b.register();
    expect(b.activeRuns).toBe(1);
  });

  it('reset() drops the participant count back to zero', () => {
    const b = new EventMemoryBudget({ totalCap: 10_000 });
    b.register();
    b.register();
    b.reset();
    expect(b.activeRuns).toBe(0);
  });
});

describe('EventMemoryBudget — fair-share per-run cap', () => {
  it('gives a lone run the entire budget', () => {
    const b = new EventMemoryBudget({ totalCap: 80_000 });
    b.register();
    expect(b.perRunEventCap()).toBe(80_000);
  });

  it('returns the full budget when no run has registered yet', () => {
    // Division guards against a zero divisor; an unregistered caller still
    // gets a sane number.
    const b = new EventMemoryBudget({ totalCap: 80_000 });
    expect(b.perRunEventCap()).toBe(80_000);
  });

  it('divides the budget evenly among concurrent runs', () => {
    const b = new EventMemoryBudget({ totalCap: 80_000 });
    for (let i = 0; i < 8; i++) b.register();
    expect(b.perRunEventCap()).toBe(10_000);
  });

  it('keeps the sum of every run’s share within the total budget', () => {
    const b = new EventMemoryBudget({ totalCap: 90_000 });
    const n = 7; // 90_000 / 7 is not integral — exercises the floor()
    for (let i = 0; i < n; i++) b.register();
    // floor() can only round a share DOWN, so n shares never exceed the cap.
    expect(b.perRunEventCap() * n).toBeLessThanOrEqual(90_000);
    expect(b.perRunEventCap() * n).toBeGreaterThan(90_000 - n);
  });

  it('floors the share so a heavily-loaded run keeps a usable tail', () => {
    const b = new EventMemoryBudget({ totalCap: 1_000 });
    for (let i = 0; i < 100; i++) b.register(); // raw share would be 10
    // MIN_PER_RUN_EVENT_CAP wins — a run never drops below 500 events.
    expect(b.perRunEventCap()).toBe(500);
  });

  it('shrinks each run’s share as concurrency rises', () => {
    const b = new EventMemoryBudget({ totalCap: 60_000 });
    b.register();
    expect(b.perRunEventCap()).toBe(60_000);
    b.register();
    expect(b.perRunEventCap()).toBe(30_000);
    b.register();
    expect(b.perRunEventCap()).toBe(20_000);
    b.unregister();
    expect(b.perRunEventCap()).toBe(30_000);
  });
});

describe('resolveTotalEventCap', () => {
  const saved = process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER;
  afterEach(() => {
    if (saved === undefined) delete process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER;
    else process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER = saved;
  });

  it('falls back to the default when the env var is unset', () => {
    delete process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER;
    expect(resolveTotalEventCap()).toBe(200_000);
  });

  it('honors a valid positive override', () => {
    process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER = '50000';
    expect(resolveTotalEventCap()).toBe(50_000);
  });

  it('rejects a non-numeric, zero, negative or empty override', () => {
    // None of these is a valid intent to disable — an unbounded buffer is
    // the very bug the budget exists to prevent — so all fall back.
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.INFLOOP_MAX_TOTAL_EVENT_BUFFER = bad;
      expect(resolveTotalEventCap()).toBe(200_000);
    }
  });
});
