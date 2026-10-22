import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { loadProviders, resolveBin } from '@/lib/server/providers/loader';
import type {
  CliProviderManifest,
  ProviderHealth,
  ProviderInfo,
  ProviderManifest,
} from '@/lib/server/providers/types';

const execFileAsync = promisify(execFile);

async function commandExists(bin: string): Promise<string | null> {
  // Path-like bins should be checked directly so env overrides such as
  // /opt/homebrew/bin/claude produce actionable messages.
  if (bin.includes('/') || path.isAbsolute(bin)) {
    try {
      await access(bin, fsConstants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      '/bin/sh',
      ['-c', 'command -v -- "$1"', 'sh', bin],
      { timeout: 2000 },
    );
    const resolved = stdout.trim().split(/\r?\n/)[0];
    return resolved || null;
  } catch {
    return null;
  }
}

async function providerHealth(manifest: ProviderManifest): Promise<ProviderHealth> {
  if (manifest.transport !== 'cli') {
    return {
      status: 'unknown',
      message: 'HTTP provider availability is checked when a run starts.',
    };
  }
  const resolvedBin = resolveBin(manifest as CliProviderManifest);
  const found = await commandExists(resolvedBin);
  if (!found) {
    return {
      status: 'missing',
      resolvedBin,
      message: `CLI binary not found or not executable: ${resolvedBin}`,
    };
  }
  return {
    status: 'available',
    resolvedBin: found,
    message: `CLI binary resolved at ${found}`,
  };
}

export async function GET(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  try {
    const manifests = await loadProviders();
    const providers: ProviderInfo[] = await Promise.all(
      manifests.map(async (m) => {
        const health = await providerHealth(m);
        return {
          id: m.id,
          label: m.label,
          description: m.description,
          glyph: m.glyph,
          transport: m.transport,
          kind: m.kind,
          connectionId: m.connectionId,
          connectionLabel: m.connectionLabel,
          available: m.transport === 'http' ? true : health.status === 'available',
          health,
          manifestSupportsHomeOverrides:
            m.transport === 'cli' && m.homeOverrideArgs !== undefined ? true : undefined,
          manifestSupportsProfile:
            m.transport === 'cli' && m.args.includes('{profile}') ? true : undefined,
          manifestSupportsModel:
            m.transport === 'cli' && m.args.includes('{model}') ? true : undefined,
          manifestSupportsAgent:
            m.transport === 'cli' && m.args.includes('{agent}') ? true : undefined,
        };
      }),
    );
    return NextResponse.json({ providers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to load providers' },
      { status: 500 },
    );
  }
}
