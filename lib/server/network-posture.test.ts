import { describe, expect, test } from 'bun:test';
import { evaluatePosture, isLoopbackHost } from './network-posture';

describe('isLoopbackHost', () => {
  test('recognises loopback literals', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  test('recognises the whole 127.0.0.0/8 range', () => {
    expect(isLoopbackHost('127.0.0.0')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('127.255.255.255')).toBe(true);
  });

  test('normalises surrounding whitespace and case', () => {
    expect(isLoopbackHost('  127.0.0.1  ')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });

  test('treats all-interfaces binds as exposed', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  test('treats an empty host as exposed (binds all interfaces)', () => {
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost('   ')).toBe(false);
  });

  test('treats LAN IPs, hostnames, and exotic forms as exposed', () => {
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('myhost.local')).toBe(false);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(false);
  });

  test('rejects malformed 127.* strings', () => {
    expect(isLoopbackHost('127.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.999')).toBe(false);
    expect(isLoopbackHost('127.foo.0.1')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
  });

  // Regression guard: this classifier is security-load-bearing, so pin the
  // look-alike forms a sloppy operator (or attacker) might hope pass as
  // loopback. Every one of these must be classified as exposed.
  test('rejects look-alike strings that must not pass as loopback', () => {
    expect(isLoopbackHost('0177.0.0.1')).toBe(false); // octal octet
    expect(isLoopbackHost('2130706433')).toBe(false); // decimal int form of 127.0.0.1
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false); // suffix
    expect(isLoopbackHost('localhost.attacker.com')).toBe(false); // suffix on literal
    expect(isLoopbackHost('127.0.0.1 0.0.0.0')).toBe(false); // embedded space
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(false); // expanded ::1, intentionally exposed
  });
});

describe('evaluatePosture', () => {
  test('loopback host always starts, no warning', () => {
    for (const authEnabled of [true, false]) {
      for (const allowInsecure of [true, false]) {
        expect(
          evaluatePosture({ host: '127.0.0.1', authEnabled, allowInsecure }),
        ).toEqual({ ok: true, warning: null });
      }
    }
  });

  test('exposed + token-gated starts with a webhook-residual note', () => {
    const d = evaluatePosture({
      host: '0.0.0.0',
      authEnabled: true,
      allowInsecure: false,
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.warning).not.toBeNull();
      expect(d.warning).toContain('webhook');
    }
  });

  test('exposed + unauthenticated + no opt-in refuses to start', () => {
    const d = evaluatePosture({
      host: '0.0.0.0',
      authEnabled: false,
      allowInsecure: false,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error).toMatch(/Refusing to start/);
      expect(d.error).toContain('INFLOOP_API_TOKEN');
      expect(d.error).toContain('INFLOOP_ALLOW_INSECURE');
      expect(d.error).toContain('HOST');
    }
  });

  test('empty host is treated as exposed and refused', () => {
    const d = evaluatePosture({
      host: '',
      authEnabled: false,
      allowInsecure: false,
    });
    expect(d.ok).toBe(false);
  });

  test('exposed + unauthenticated + opt-in starts with a loud banner', () => {
    const d = evaluatePosture({
      host: '0.0.0.0',
      authEnabled: false,
      allowInsecure: true,
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.warning).not.toBeNull();
      expect(d.warning).toMatch(/INSECURE MODE/);
    }
  });

  test('a specific LAN IP is exposed, not loopback', () => {
    const d = evaluatePosture({
      host: '192.168.1.50',
      authEnabled: false,
      allowInsecure: false,
    });
    expect(d.ok).toBe(false);
  });
});
