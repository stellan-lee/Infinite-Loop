import { describe, expect, it } from 'bun:test';
import {
  CORRELATION_HEADER,
  isCorrelationId,
  newCorrelationId,
} from './correlation';

describe('newCorrelationId', () => {
  it('produces the `cid_` + 24-char base64url shape', () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^cid_[A-Za-z0-9_-]{24}$/);
  });

  it('is unique across a large batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newCorrelationId());
    expect(seen.size).toBe(10_000);
  });
});

describe('isCorrelationId', () => {
  it('accepts a freshly minted id', () => {
    expect(isCorrelationId(newCorrelationId())).toBe(true);
  });

  it('rejects the wrong shape, prefix, length, and non-strings', () => {
    expect(isCorrelationId('')).toBe(false);
    expect(isCorrelationId('cid_short')).toBe(false);
    expect(isCorrelationId('run-1234')).toBe(false);
    expect(isCorrelationId('cid_' + 'x'.repeat(23))).toBe(false);
    expect(isCorrelationId('cid_' + 'x'.repeat(25))).toBe(false);
    expect(isCorrelationId('cid_' + '!'.repeat(24))).toBe(false);
    expect(isCorrelationId(undefined)).toBe(false);
    expect(isCorrelationId(42)).toBe(false);
  });
});

describe('CORRELATION_HEADER', () => {
  it('is the conventional lowercase header name', () => {
    expect(CORRELATION_HEADER).toBe('x-correlation-id');
  });
});
