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
