/*
 * CLI: restore the Infinite Loop data directory from a .tar.gz snapshot.
 *
 *   bun scripts/restore.ts <archive> [--force]
 *   bun scripts/restore.ts <archive> --inspect
 *
 * Stop the server before restoring. When the data directory (INFLOOP_DATA_DIR)
 * is not empty, --force is required: its current contents are moved aside into
 * a `.pre-restore-<timestamp>` directory — not deleted — before the restore.
 * `--inspect` prints the archive's manifest and does not touch any data.
 * Full guide: docs/backup-restore.md.
 */

import { inspectBackup, restoreBackup } from '../lib/server/backup';

const USAGE = 'Usage: bun scripts/restore.ts <archive> [--force] [--inspect]';

function parseArgs(argv: string[]): {
  archive?: string;
  force: boolean;
  inspect: boolean;
} {
  let archive: string | undefined;
  let force = false;
  let inspect = false;
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--inspect') {
      inspect = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`error: unknown option: ${arg}`);
      console.error(USAGE);
      process.exit(2);
    } else if (archive === undefined) {
      archive = arg;
    } else {
      console.error(`error: unexpected argument: ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return { archive, force, inspect };
}

const { archive, force, inspect } = parseArgs(process.argv.slice(2));

if (!archive) {
  console.error('error: missing <archive> argument');
  console.error(USAGE);
  process.exit(2);
}

try {
  if (inspect) {
    const { manifest, entries } = await inspectBackup(archive);
    console.log(`Archive: ${archive}`);
    console.log(`  format:   ${manifest.format} v${manifest.formatVersion}`);
    console.log(`  created:  ${manifest.createdAt}`);
    console.log(`  app:      ${manifest.appVersion}`);
    console.log(`  hostname: ${manifest.hostname}`);
    console.log(`  data dir: ${manifest.dataDir}`);
    console.log(`  members:  ${entries.length}`);
    if (manifest.uncoveredPaths.length > 0) {
      console.log('  NOT covered by this backup (restore separately):');
      for (const p of manifest.uncoveredPaths) {
        console.log(`    - ${p}`);
      }
    }
  } else {
    const result = await restoreBackup({ archivePath: archive, force });
    console.log(
      `Restored ${result.restoredItems.length} item(s) into ${result.dataDir}`,
    );
    console.log(`  from backup created ${result.manifest.createdAt}`);
    if (result.movedAsideTo) {
      console.log(`  previous contents moved to: ${result.movedAsideTo}`);
      console.log('  delete that directory once the restore is verified.');
    }
    if (result.manifest.uncoveredPaths.length > 0) {
      console.warn('');
      console.warn(
        'WARNING: the source deployment kept data OUTSIDE the data directory',
      );
      console.warn(
        'that this backup never contained — restore those separately:',
      );
      for (const p of result.manifest.uncoveredPaths) {
        console.warn(`  - ${p}`);
      }
    }
    console.log('');
    console.log('Restart the server to pick up the restored state.');
  }
} catch (err) {
  console.error(`Restore failed: ${(err as Error).message}`);
  process.exit(1);
}
