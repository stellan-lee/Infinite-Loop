import { describe, expect, it } from 'bun:test';
import { resolve } from './templating';
import type { Scope } from '../shared/workflow';

describe('resolve', () => {
  it('passes plain text through unchanged with no warnings', () => {
    const result = resolve('hello world', {});
    expect(result.text).toBe('hello world');
    expect(result.warnings).toEqual([]);
  });

  it('resolves a single key path', () => {
    const scope: Scope = { a: { b: 'hi' } };
    const result = resolve('{{a.b}}', scope);
    expect(result.text).toBe('hi');
    expect(result.warnings).toEqual([]);
  });

  it('resolves multiple replacements within one string', () => {
    const scope: Scope = { a: { x: '1', y: '2' } };
    const result = resolve('X={{a.x}} Y={{a.y}}', scope);
    expect(result.text).toBe('X=1 Y=2');
    expect(result.warnings).toEqual([]);
  });

  it('emits an empty replacement and a warning for a missing key path', () => {
    const scope: Scope = { a: { b: 'hi' } };
    const result = resolve('value=[{{a.missing}}]', scope);
    expect(result.text).toBe('value=[]');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({ field: '', missingKey: 'a.missing' });
  });

  it('stringifies numeric values', () => {
    const scope: Scope = { a: { n: 42 } };
    const result = resolve('{{a.n}}', scope);
    expect(result.text).toBe('42');
    expect(result.warnings).toEqual([]);
  });

  it('tolerates whitespace inside the braces', () => {
    const scope: Scope = { a: { b: 'hi' } };
    const result = resolve('{{  a.b  }}', scope);
    expect(result.text).toBe('hi');
    expect(result.warnings).toEqual([]);
  });

  it('stringifies booleans', () => {
    const scope: Scope = { run: { ok: true } };
    const result = resolve('flag={{run.ok}}', scope);
    expect(result.text).toBe('flag=true');
    expect(result.warnings).toEqual([]);
  });

  it('treats null and undefined values as missing', () => {
    const scope: Scope = { a: { b: null, c: undefined } };
    const result = resolve('[{{a.b}}][{{a.c}}]', scope);
    expect(result.text).toBe('[][]');
    expect(result.warnings.map((w) => w.missingKey)).toEqual(['a.b', 'a.c']);
  });

  it('reports missing key when descending into a non-object', () => {
    const scope: Scope = { a: { b: 'hi' } };
    const result = resolve('{{a.b.c}}', scope);
    expect(result.text).toBe('');
    expect(result.warnings).toEqual([{ field: '', missingKey: 'a.b.c' }]);
  });
});

describe('resolve — | default fallback', () => {
  it('substitutes the default when the key is missing, with no warning', () => {
    const result = resolve('value=[{{a.missing | default fallback}}]', {});
    expect(result.text).toBe('value=[fallback]');
    expect(result.warnings).toEqual([]);
  });

  it('ignores the default when the key resolves', () => {
    const scope: Scope = { a: { b: 'real' } };
    const result = resolve('{{a.b | default fallback}}', scope);
    expect(result.text).toBe('real');
    expect(result.warnings).toEqual([]);
  });

  it('uses the default for both null and undefined values', () => {
    const scope: Scope = { a: { b: null, c: undefined } };
    const result = resolve('[{{a.b | default X}}][{{a.c | default Y}}]', scope);
    expect(result.text).toBe('[X][Y]');
    expect(result.warnings).toEqual([]);
  });

  it('does NOT apply the default to an explicit empty-string value', () => {
    const scope: Scope = { a: { b: '' } };
    const result = resolve('[{{a.b | default fallback}}]', scope);
    expect(result.text).toBe('[]');
    expect(result.warnings).toEqual([]);
  });

  it('preserves internal spaces in the default value', () => {
    const result = resolve('{{x.y | default hello world}}', {});
    expect(result.text).toBe('hello world');
    expect(result.warnings).toEqual([]);
  });

  it('tolerates whitespace around the | default clause', () => {
    const result = resolve('{{  x.y  |  default   spaced  }}', {});
    expect(result.text).toBe('spaced');
    expect(result.warnings).toEqual([]);
  });

  it('treats an empty default as an empty fallback with no warning', () => {
    const result = resolve('[{{x.y | default }}]', {});
    expect(result.text).toBe('[]');
    expect(result.warnings).toEqual([]);
  });

  it('resolves each placeholder against its own default', () => {
    const scope: Scope = { a: { present: 'P' } };
    const result = resolve(
      '{{a.present | default D1}}/{{a.absent | default D2}}',
      scope,
    );
    expect(result.text).toBe('P/D2');
    expect(result.warnings).toEqual([]);
  });

  it('leaves a non-default pipe expression as literal text', () => {
    // `| foo` is not a `default` clause, so the whole placeholder fails to
    // match and passes through unchanged — same as before this feature.
    const result = resolve('{{a.b | foo}}', { a: { b: 'hi' } });
    expect(result.text).toBe('{{a.b | foo}}');
    expect(result.warnings).toEqual([]);
  });

  it('leaves `{{ref|default}}` (no space after default) as literal text', () => {
    // `default` must be followed by whitespace; without it the placeholder
    // does not match and is emitted verbatim, with no warning.
    const result = resolve('{{a.b|default}}', {});
    expect(result.text).toBe('{{a.b|default}}');
    expect(result.warnings).toEqual([]);
  });
});
