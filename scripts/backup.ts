/*
 * CLI: write a .tar.gz snapshot of the Infinite Loop data directory.
 *
 *   bun scripts/backup.ts [--out <path>]
 *
 * The data directory is INFLOOP_DATA_DIR (default ~/.infinite-loop, /data in
 * the Docker image). A backup may be taken while the server is running — see
 * the consistency model in lib/server/backup.ts. Full guide:
 * docs/backup-restore.md.
 */

import { createBackup } from '../lib/server/backup';

const USAGE = 'Usage: bun scripts/backup.ts [--out <path>]';

function parseArgs(argv: string[]): { out?: string } {
  const opts: { out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const value = argv[++i];
      if (!value) {
        console.error('error: --out requires a path');
        process.exit(2);
      }
      opts.out = value;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) {
        console.error('error: --out requires a path');
        process.exit(2);
      }
      opts.out = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`error: unknown argument: ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return opts;
}

const { out } = parseArgs(process.argv.slice(2));

try {
  const result = await createBackup({ outPath: out });
  const mib = (result.bytes / 1024 / 1024).toFixed(2);
  console.log(`Backup written: ${result.outPath} (${mib} MiB)`);
  console.log(`  created:  ${result.manifest.createdAt}`);
  console.log(`  data dir: ${result.manifest.dataDir}`);
  if (result.manifest.uncoveredPaths.length > 0) {
    console.warn('');
    console.warn(
      'WARNING: these configured paths resolve OUTSIDE the data directory',
    );
    console.warn(
      'and are NOT included in this backup — back them up separately:',
    );
    for (const p of result.manifest.uncoveredPaths) {
      console.warn(`  - ${p}`);
    }
  }
} catch (err) {
  console.error(`Backup failed: ${(err as Error).message}`);
  process.exit(1);
}
