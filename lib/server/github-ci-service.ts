import { createHash } from 'node:crypto';
import { GitHubCIClient, aggregateCI } from './github-ci-client';
import {
  isGitHubCITerminal,
  validateGitHubCIConfig,
  type GitHubCIConfig,
  type GitHubCIOutput,
} from '../shared/github-ci';
import { readDurableJSON, writeDurableJSON } from './durable-json';

export interface GitHubCIWait {
  config: GitHubCIConfig;
  deadline: number;
  output: GitHubCIOutput;
}
interface ActiveWait {
  state: GitHubCIWait;
  publish: (output: GitHubCIOutput) => void;
  finish: (output: GitHubCIOutput) => void;
  reject: (error: unknown) => void;
}
interface Delivery {
  id: string;
  repository: string;
  event: string;
  receivedAt: number;
  done: boolean;
}

export class GitHubCIService {
  private waits = new Set<ActiveWait>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private client = new GitHubCIClient()) {}

  create(config: GitHubCIConfig, maxDeadline = Infinity): GitHubCIWait {
    validateGitHubCIConfig(config, true);
    if (!process.env.INFLOOP_GITHUB_WEBHOOK_SECRET) {
      throw new Error('INFLOOP_GITHUB_WEBHOOK_SECRET is required for GitHub CI');
    }
    return {
      config,
      deadline: Math.min(Date.now() + config.timeoutMs, maxDeadline),
      output: aggregateCI(config, '', []),
    };
  }

  wait(state: GitHubCIWait, signal: AbortSignal, publish: ActiveWait['publish']): Promise<GitHubCIOutput> {
    if (isGitHubCITerminal(state.output.status)) return Promise.resolve(state.output);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.waits.delete(active);
      };
      const active: ActiveWait = {
        state,
        publish,
        finish: output => { cleanup(); resolve(output); },
        reject: error => { cleanup(); reject(error); },
      };
      const terminal = (status: 'Error' | 'Cancelled', message: string) => {
        const output = { ...state.output, status, errorMessage: message, updatedAt: Date.now() };
        try {
          state.output = output;
          publish(output);
          active.finish(output);
        } catch (err) {
          active.reject(err);
        }
      };
      const cancel = () => terminal('Cancelled', 'CI gate cancelled');
      this.waits.add(active);
      signal.addEventListener('abort', cancel, { once: true });
      const timeout = () => terminal('Error', 'CI gate timed out before every required result succeeded');
      if (signal.aborted) cancel();
      else if (state.deadline <= Date.now()) timeout();
      else {
        timer = setTimeout(timeout, state.deadline - Date.now());
        void this.reconcile(state.config.repository).catch(active.reject);
      }
    });
  }

  reconcile(repository?: string): Promise<void> {
    const task = this.tail.then(async () => {
      for (const active of [...this.waits]) {
        if (repository && active.state.config.repository.toLowerCase() !== repository.toLowerCase()) continue;
        let output: GitHubCIOutput;
        try {
          output = await this.client.reconcile(active.state.config);
        } catch (err) {
          output = {
            ...active.state.output,
            status: 'Error',
            errorMessage: err instanceof Error ? err.message : 'GitHub reconciliation failed',
            updatedAt: Date.now(),
          };
        }
        // A timeout or cancellation may settle while the network is in flight.
        if (!this.waits.has(active)) continue;
        if (Date.now() >= active.state.deadline) {
          output = { ...output, status: 'Error', errorMessage: 'CI gate timed out before every required result succeeded' };
        }
        try {
          active.state.output = output;
          // Persist terminal state BEFORE resolving the workflow continuation.
          active.publish(output);
          if (isGitHubCITerminal(output.status)) active.finish(output);
        } catch (err) {
          active.reject(err);
          throw err;
        }
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  /** Store authenticated routing hints, never tokens or webhook bodies. */
  accept(deliveryId: string, event: string, repository: string): void {
    const id = createHash('sha256').update(deliveryId).digest('hex');
    const existing = readDurableJSON<Delivery>('github-ci-inbox').find(d => d.id === id);
    if (!existing) {
      writeDurableJSON('github-ci-inbox', id, {
        id, event, repository, receivedAt: Date.now(), done: false,
      } satisfies Delivery);
    }
    // Acknowledge after the durable write; network work runs outside the request.
    setImmediate(() => {
      void this.drainInbox().catch(() => { /* Retained for explicit/boot reconciliation. */ });
    });
  }

  async drainInbox(): Promise<void> {
    for (const delivery of readDurableJSON<Delivery>('github-ci-inbox')) {
      if (delivery.done) continue;
      await this.reconcile(delivery.repository);
      writeDurableJSON('github-ci-inbox', delivery.id, { ...delivery, done: true });
    }
  }
}

const globalCI = globalThis as typeof globalThis & { __infloopGitHubCI?: GitHubCIService };
export const githubCIService = globalCI.__infloopGitHubCI ??= new GitHubCIService();
