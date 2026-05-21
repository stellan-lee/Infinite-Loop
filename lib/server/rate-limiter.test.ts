import { describe, expect, it } from 'bun:test';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('admits requests up to capacity, then rejects', () => {
    const rl = new RateLimiter(() => 3, 60_000);
    expect(rl.check('k', 0).ok).toBe(true);
    expect(rl.check('k', 0).ok).toBe(true);
    expect(rl.check('k', 0).ok).toBe(true);
    const denied = rl.check('k', 0);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps an independent bucket per key', () => {
    const rl = new RateLimiter(() => 1, 60_000);
    expect(rl.check('a', 0).ok).toBe(true);
    expect(rl.check('a', 0).ok).toBe(false);
    // a different key is untouched
    expect(rl.check('b', 0).ok).toBe(true);
  });

  it('refills tokens as time passes', () => {
    const rl = new RateLimiter(() => 60, 60_000); // one token per 1000 ms
    for (let i = 0; i < 60; i++) expect(rl.check('k', 0).ok).toBe(true);
    expect(rl.check('k', 0).ok).toBe(false);
    // exactly one token is back 1000 ms later
    expect(rl.check('k', 1000).ok).toBe(true);
    expect(rl.check('k', 1000).ok).toBe(false);
  });

  it('caps refill at capacity — idle time does not bank extra tokens', () => {
    const rl = new RateLimiter(() => 5, 60_000);
    // idle for ten windows, then drain: still only `capacity` admitted
    let admitted = 0;
    for (let i = 0; i < 20; i++) if (rl.check('k', 600_000).ok) admitted++;
    expect(admitted).toBe(5);
  });

  it('reports Retry-After rounded up to whole seconds', () => {
    const rl = new RateLimiter(() => 2, 60_000); // one token per 30 s
    expect(rl.check('k', 0).ok).toBe(true);
    expect(rl.check('k', 0).ok).toBe(true);
    const denied = rl.check('k', 0);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSeconds).toBe(30);
  });

  it('re-reads the limit on every check', () => {
    let limit = 1;
    const rl = new RateLimiter(() => limit, 60_000);
    expect(rl.check('a', 0).ok).toBe(true);
    expect(rl.check('a', 0).ok).toBe(false); // 'a' is exhausted at limit 1

    limit = 3; // raise the ceiling at runtime
    // a key first seen under the new limit gets the new, larger capacity
    expect(rl.check('b', 0).ok).toBe(true);
    expect(rl.check('b', 0).ok).toBe(true);
    expect(rl.check('b', 0).ok).toBe(true);
    expect(rl.check('b', 0).ok).toBe(false);
  });

  it('does not mint tokens when the clock steps backward', () => {
    const rl = new RateLimiter(() => 1, 60_000);
    expect(rl.check('k', 10_000).ok).toBe(true);
    expect(rl.check('k', 10_000).ok).toBe(false);
    // an earlier timestamp must not be treated as elapsed refill time
    expect(rl.check('k', 0).ok).toBe(false);
  });

  it('sweeps fully-refilled buckets but keeps recently-drained ones', () => {
    const rl = new RateLimiter(() => 10, 1_000);
    rl.check('warmup', 1_000); // first sweep fires here (lastSweep -> 1000)
    for (let i = 0; i < 10; i++) rl.check('hot', 1_500); // drain 'hot' at t=1500
    expect(rl.size()).toBe(2);
    rl.check('probe', 2_000); // second sweep fires here
    // 'warmup' refilled over a full window and is swept; 'hot' has only
    // half-refilled and is kept; 'probe' was just created.
    expect(rl.size()).toBe(2);
  });

  it('reset() drops all bucket state', () => {
    const rl = new RateLimiter(() => 1, 60_000);
    rl.check('k', 0);
    expect(rl.size()).toBe(1);
    rl.reset();
    expect(rl.size()).toBe(0);
    expect(rl.check('k', 0).ok).toBe(true); // a fresh, full bucket
  });

  it('treats a non-positive limit as a capacity of one', () => {
    const rl = new RateLimiter(() => 0, 60_000);
    expect(rl.check('k', 0).ok).toBe(true);
    expect(rl.check('k', 0).ok).toBe(false);
  });
});
