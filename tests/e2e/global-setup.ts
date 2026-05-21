/*
 * Playwright global setup — runs once before the shared `webServer` boots.
 *
 * Builds a clean, hermetic fixture environment under tests/e2e/.tmp/ so the
 * suite never touches the developer's real ~/.infinite-loop data dir.
 */
import { DATA_DIR, PROVIDERS_DIR, TMP_DIR } from './lib/env';
import { resetDir, seedDataDir, writeStubProvider } from './lib/server';

export default function globalSetup(): void {
  resetDir(TMP_DIR);
  seedDataDir(DATA_DIR);
  writeStubProvider(PROVIDERS_DIR);
}
