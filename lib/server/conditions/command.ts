import { exec } from 'node:child_process';
import { buildChildEnv } from '../child-env';
import type { CommandConfig, ConditionStrategy } from '../../shared/types';

const TIMEOUT_MS = 30000;

function isCommandConfig(cfg: unknown): cfg is CommandConfig {
  return (
    typeof cfg === 'object' &&
    cfg !== null &&
    typeof (cfg as { cmd?: unknown }).cmd === 'string'
  );
}

export const commandStrategy: ConditionStrategy = {
  evaluate(_iter, cfg, cwd) {
    if (!isCommandConfig(cfg)) {
      return Promise.resolve({ met: false, detail: 'invalid command config' });
    }

    return new Promise((resolve) => {
      let timedOut = false;

      // A `kind: command` condition runs an operator/AI-authored shell
      // command — an untrusted-execution surface alongside Agent and Script
      // nodes. Scrub the environment with the shared allowlist so the command
      // cannot read the orchestrator's own secrets (`INFLOOP_API_TOKEN`, cloud
      // credentials) out of the inherited `process.env`.
      const child = exec(cfg.cmd, { cwd, env: buildChildEnv() }, (err) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({
            met: false,
            detail: `command timed out after ${TIMEOUT_MS}ms`,
          });
          return;
        }

        if (err === null) {
          resolve({ met: true, detail: 'exit 0' });
          return;
        }

        const code = (err as NodeJS.ErrnoException & { code?: number | string })
          .code;
        if (typeof code === 'number') {
          resolve({ met: false, detail: `exit ${code}` });
          return;
        }

        resolve({ met: false, detail: `check error: ${err.message}` });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TIMEOUT_MS);
    });
  },
};
