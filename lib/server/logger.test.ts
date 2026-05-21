import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  type Mock,
} from 'bun:test';
import { createLogger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;

describe('createLogger', () => {
  let logSpy: AnyMock;
  let errSpy: AnyMock;
  const origLevel = process.env.INFLOOP_LOG_LEVEL;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errSpy = spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.INFLOOP_LOG_LEVEL;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (origLevel === undefined) delete process.env.INFLOOP_LOG_LEVEL;
    else process.env.INFLOOP_LOG_LEVEL = origLevel;
  });

  function lastLine(spy: AnyMock): Record<string, unknown> {
    const calls = spy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return JSON.parse(calls[calls.length - 1][0] as string);
  }

  it('emits info to stdout as a JSON line with core fields', () => {
    createLogger('demo').info('hello');
    expect(errSpy).not.toHaveBeenCalled();
    const rec = lastLine(logSpy);
    expect(rec.level).toBe('info');
    expect(rec.scope).toBe('demo');
    expect(rec.msg).toBe('hello');
    expect(typeof rec.ts).toBe('string');
    expect(Number.isNaN(Date.parse(rec.ts as string))).toBe(false);
  });

  it('routes warn and error to stderr', () => {
    const log = createLogger('demo');
    log.warn('careful');
    log.error('broken');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(lastLine(errSpy).level).toBe('error');
  });

  it('suppresses debug at the default (info) level', () => {
    createLogger('demo').debug('noisy');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits debug when INFLOOP_LOG_LEVEL=debug', () => {
    process.env.INFLOOP_LOG_LEVEL = 'debug';
    createLogger('demo').debug('noisy');
    expect(lastLine(logSpy).level).toBe('debug');
  });

  it('suppresses warn when INFLOOP_LOG_LEVEL=error', () => {
    process.env.INFLOOP_LOG_LEVEL = 'error';
    const log = createLogger('demo');
    log.warn('careful');
    log.error('broken');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(lastLine(errSpy).msg).toBe('broken');
  });

  it('falls back to info level for an unrecognized INFLOOP_LOG_LEVEL', () => {
    process.env.INFLOOP_LOG_LEVEL = 'verbose';
    const log = createLogger('demo');
    log.debug('noisy');
    log.info('ok');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lastLine(logSpy).msg).toBe('ok');
  });

  it('merges caller fields into the record', () => {
    createLogger('demo').info('with fields', { triggerId: 't-1', count: 3 });
    const rec = lastLine(logSpy);
    expect(rec.triggerId).toBe('t-1');
    expect(rec.count).toBe(3);
  });

  it('serializes an Error field to message + stack', () => {
    createLogger('demo').error('failed', { err: new Error('boom') });
    const rec = lastLine(errSpy);
    const err = rec.err as { message: string; stack: string };
    expect(err.message).toBe('boom');
    expect(typeof err.stack).toBe('string');
  });

  it('does not let a caller field clobber a reserved key', () => {
    createLogger('demo').info('msg', { level: 'HACKED', scope: 'evil' });
    const rec = lastLine(logSpy);
    expect(rec.level).toBe('info');
    expect(rec.scope).toBe('demo');
  });

  it('never throws on a non-serializable (circular) field', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createLogger('demo').info('circular', { circular })).not.toThrow();
    const rec = lastLine(logSpy);
    expect(rec._logError).toBe('fields not serializable');
    expect(rec.msg).toBe('circular');
  });
});
