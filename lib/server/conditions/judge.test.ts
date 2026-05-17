import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeStrategy } from './judge';
import { _resetProviderCache } from '../providers/loader';
import type { IterationRecord } from '../../shared/types';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = resolve(here, '../../../tests/fixtures/fake-judge-claude.sh');

function makeIter(stdout = ''): IterationRecord {
  return {
    n: 1,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 0,
    timedOut: false,
  };
}

let providersDir: string;
let prevProvidersDir: string | undefined;

describe('judgeStrategy', () => {
  beforeEach(() => {
    // Seed an isolated providers/ dir so the test doesn't depend on cwd.
    providersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-judge-test-'));
    prevProvidersDir = process.env.INFLOOP_PROVIDERS_DIR;
    process.env.INFLOOP_PROVIDERS_DIR = providersDir;
    fs.writeFileSync(
      path.join(providersDir, 'claude.json'),
      JSON.stringify({
        id: 'claude',
        label: 'Claude',
        description: 'fake',
        bin: 'claude',
        args: ['{prompt}'],
        outputFormat: 'plain',
      }),
    );
    _resetProviderCache();
    process.env.INFLOOP_CLAUDE_BIN = FAKE_BIN;
    delete process.env.FAKE_JUDGE_OUTPUT;
    delete process.env.FAKE_JUDGE_EXIT;
    delete process.env.FAKE_JUDGE_SLEEP_MS;
  });

  afterEach(async () => {
    if (prevProvidersDir === undefined) {
      delete process.env.INFLOOP_PROVIDERS_DIR;
    } else {
      process.env.INFLOOP_PROVIDERS_DIR = prevProvidersDir;
    }
    delete process.env.INFLOOP_CLAUDE_BIN;
    await fsp.rm(providersDir, { recursive: true, force: true });
    _resetProviderCache();
  });

  it('returns met:true when judge outputs MET', async () => {
    process.env.FAKE_JUDGE_OUTPUT = 'MET';
    const result = await judgeStrategy.evaluate(
      makeIter('iteration produced the goal'),
      { rubric: 'task is done' },
      process.cwd(),
    );
    expect(result.met).toBe(true);
    expect(result.detail).toBe('MET');
  });

  it('returns met:false when judge outputs NOT_MET', async () => {
    process.env.FAKE_JUDGE_OUTPUT = 'NOT_MET';
    const result = await judgeStrategy.evaluate(
      makeIter('still working'),
      { rubric: 'task is done' },
      process.cwd(),
    );
    expect(result.met).toBe(false);
    expect(result.detail).toBe('NOT_MET');
  });

  it('returns met:false with unparseable detail when output is not MET/NOT_MET', async () => {
    process.env.FAKE_JUDGE_OUTPUT = 'I think it is met';
    const result = await judgeStrategy.evaluate(
      makeIter('some output'),
      { rubric: 'task is done' },
      process.cwd(),
    );
    expect(result.met).toBe(false);
    expect(result.detail).toMatch(/unparseable/);
    expect(result.detail).toContain('I think it is met');
  });

  it('returns met:false with error detail when judge exits non-zero', async () => {
    process.env.FAKE_JUDGE_OUTPUT = 'whatever';
    process.env.FAKE_JUDGE_EXIT = '3';
    const result = await judgeStrategy.evaluate(
      makeIter('output'),
      { rubric: 'task is done' },
      process.cwd(),
    );
    expect(result.met).toBe(false);
    expect(result.detail).toMatch(/judge error/);
  });

  it('returns met:false on invalid config shape', async () => {
    const result = await judgeStrategy.evaluate(
      makeIter('output'),
      { rubric: '' }, // empty rubric
      process.cwd(),
    );
    expect(result.met).toBe(false);
    expect(result.detail).toBe('invalid judge config');

    const result2 = await judgeStrategy.evaluate(
      makeIter('output'),
      null,
      process.cwd(),
    );
    expect(result2.met).toBe(false);
    expect(result2.detail).toBe('invalid judge config');

    const result3 = await judgeStrategy.evaluate(
      makeIter('output'),
      { rubric: 'ok', model: 123 },
      process.cwd(),
    );
    expect(result3.met).toBe(false);
    expect(result3.detail).toBe('invalid judge config');
  });
});
