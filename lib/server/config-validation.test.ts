import { describe, expect, it } from 'bun:test';
import { validateConfig } from './config-validation';

/*
 * Startup config validation — the boot gate that turns a silently-misparsed
 * INFLOOP_* var into a refusal to start.
 *
 * `validateConfig` is pure: it reads only the env map it is handed, so every
 * case here is a plain in-memory map — no process.env mutation, no restore.
 */

describe('validateConfig — absent or empty values', () => {
  it('reports nothing for a fully empty env', () => {
    expect(validateConfig({})).toEqual([]);
  });

  it('treats an empty string as unset', () => {
    expect(validateConfig({ INFLOOP_MAX_TOTAL_COST_USD: '' })).toEqual([]);
  });

  it('treats a whitespace-only value as unset', () => {
    expect(validateConfig({ INFLOOP_MAX_RUN_DURATION_MS: '   ' })).toEqual([]);
  });
});

describe('validateConfig — valid values', () => {
  it('accepts a well-formed value for every variable', () => {
    expect(
      validateConfig({
        INFLOOP_MAX_RUN_NODE_EXECUTIONS: '2000',
        INFLOOP_MAX_RUN_DURATION_MS: '1800000',
        INFLOOP_MAX_RUN_COST_USD: '5',
        INFLOOP_MAX_TOTAL_COST_USD: '100.50',
        INFLOOP_MAX_CONCURRENT_RUNS: '8',
        INFLOOP_MAX_TOTAL_EVENT_BUFFER: '200000',
        INFLOOP_RUN_HISTORY_LIMIT: '100',
        INFLOOP_AUDIT_MAX_BYTES: '5000000',
        INFLOOP_AUDIT_MAX_FILES: '5',
        INFLOOP_WEBHOOK_RATE_LIMIT: '120',
        INFLOOP_LOGIN_RATE_LIMIT: '20',
        INFLOOP_LOG_LEVEL: 'info',
        INFLOOP_EGRESS_ENFORCE: '1',
        INFLOOP_ALLOW_INSECURE: '0',
      }),
    ).toEqual([]);
  });

  it('tolerates surrounding whitespace on an otherwise valid value', () => {
    expect(validateConfig({ INFLOOP_MAX_RUN_COST_USD: '  5.50  ' })).toEqual([]);
  });

  it('accepts a literal 0 where 0 is a meaningful "disable the cap" value', () => {
    expect(
      validateConfig({
        INFLOOP_MAX_RUN_NODE_EXECUTIONS: '0',
        INFLOOP_MAX_RUN_DURATION_MS: '0',
        INFLOOP_MAX_RUN_COST_USD: '0',
        INFLOOP_MAX_TOTAL_COST_USD: '0',
      }),
    ).toEqual([]);
  });

  it('accepts every log level, case-insensitively', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'WARN', 'Error']) {
      expect(validateConfig({ INFLOOP_LOG_LEVEL: level })).toEqual([]);
    }
  });
});

describe('validateConfig — the headline hazard: a typo-disabled spend cap', () => {
  it('rejects a non-numeric cost ceiling instead of letting it fall back to disabled', () => {
    const errors = validateConfig({ INFLOOP_MAX_TOTAL_COST_USD: 'abc' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('INFLOOP_MAX_TOTAL_COST_USD');
    expect(errors[0]).toContain('abc');
  });

  it('rejects a per-run cost cap that was fat-fingered with trailing units', () => {
    // parseFloat('5usd') would silently resolve to 5; a stricter gate refuses
    // the ambiguous value rather than guessing the operator's intent.
    const errors = validateConfig({ INFLOOP_MAX_RUN_COST_USD: '5usd' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('INFLOOP_MAX_RUN_COST_USD');
  });
});

describe('validateConfig — malformed numeric values', () => {
  it('rejects a non-numeric integer var', () => {
    expect(validateConfig({ INFLOOP_MAX_RUN_DURATION_MS: 'soon' })).toHaveLength(1);
  });

  it('rejects a negative value', () => {
    expect(validateConfig({ INFLOOP_MAX_RUN_NODE_EXECUTIONS: '-1' })).toHaveLength(1);
  });

  it('rejects trailing garbage that parseInt would silently truncate', () => {
    expect(validateConfig({ INFLOOP_MAX_RUN_DURATION_MS: '100x' })).toHaveLength(1);
  });

  it('rejects exponent notation that parseInt would misparse to 1', () => {
    // Number.parseInt('1e6', 10) === 1 — a 1ms cap, not the intended 1e6.
    expect(validateConfig({ INFLOOP_MAX_RUN_DURATION_MS: '1e6' })).toHaveLength(1);
  });

  it('rejects a fractional value for an integer-valued var', () => {
    expect(validateConfig({ INFLOOP_MAX_CONCURRENT_RUNS: '2.5' })).toHaveLength(1);
  });

  it('accepts a fractional value for a dollar-valued var', () => {
    expect(validateConfig({ INFLOOP_MAX_RUN_COST_USD: '2.5' })).toEqual([]);
  });
});

describe('validateConfig — positive-only vars reject zero', () => {
  it('rejects 0 for a var whose runtime parser falls back on a non-positive value', () => {
    for (const name of [
      'INFLOOP_MAX_CONCURRENT_RUNS',
      'INFLOOP_MAX_TOTAL_EVENT_BUFFER',
      'INFLOOP_RUN_HISTORY_LIMIT',
      'INFLOOP_AUDIT_MAX_BYTES',
      'INFLOOP_AUDIT_MAX_FILES',
      'INFLOOP_WEBHOOK_RATE_LIMIT',
      'INFLOOP_LOGIN_RATE_LIMIT',
    ]) {
      expect(validateConfig({ [name]: '0' })).toHaveLength(1);
    }
  });
});

describe('validateConfig — enum and flag vars', () => {
  it('rejects an out-of-set log level', () => {
    const errors = validateConfig({ INFLOOP_LOG_LEVEL: 'verbose' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('debug, info, warn, error');
  });

  it('accepts 0 and 1 for a flag var', () => {
    expect(validateConfig({ INFLOOP_EGRESS_ENFORCE: '0' })).toEqual([]);
    expect(validateConfig({ INFLOOP_EGRESS_ENFORCE: '1' })).toEqual([]);
  });

  it('rejects a flag set to a truthy-looking word that reads as "off"', () => {
    // INFLOOP_EGRESS_ENFORCE is compared `=== '1'`, so 'true' silently
    // disables egress enforcement — exactly the silent footgun to catch.
    const errors = validateConfig({ INFLOOP_EGRESS_ENFORCE: 'true' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('INFLOOP_EGRESS_ENFORCE');
  });
});

describe('validateConfig — multiple problems', () => {
  it('reports one error per malformed variable', () => {
    const errors = validateConfig({
      INFLOOP_MAX_TOTAL_COST_USD: 'abc',
      INFLOOP_MAX_CONCURRENT_RUNS: '0',
      INFLOOP_LOG_LEVEL: 'loud',
      INFLOOP_MAX_RUN_COST_USD: '12.00', // valid — must not appear
    });
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => e.includes('INFLOOP_MAX_RUN_COST_USD'))).toBe(false);
  });
});
