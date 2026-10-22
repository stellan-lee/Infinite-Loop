import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths';

/** Fail closed: callers must not acknowledge or advance after a failed write. */
export function writeDurableJSON(group: string, id: string, value: unknown): void {
  const directory = path.join(dataDir(), group);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function readDurableJSON<T>(group: string): T[] {
  const directory = path.join(dataDir(), group);
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return files.filter(f => f.endsWith('.json')).map(file => JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as T);
}
export function removeDurableJSON(group: string, id: string): void {
  rmSync(path.join(dataDir(), group, `${id}.json`), { force: true });
}
