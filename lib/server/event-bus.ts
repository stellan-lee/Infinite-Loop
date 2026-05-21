import type { WorkflowEvent } from '../shared/workflow';
import { createLogger } from './logger';

type Subscriber = (event: WorkflowEvent) => void;

const log = createLogger('event-bus');

class EventBus {
  private subscribers = new Set<Subscriber>();

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  emit(event: WorkflowEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        log.error('subscriber threw', { err });
      }
    }
  }

  clear(): void {
    this.subscribers.clear();
  }
}

// Pin the singleton to `globalThis` so Next.js dev mode (which can recompile
// route modules on demand and produce more than one copy of this module
// graph) cannot end up with separate buses for the producer (engine) and the
// consumer (SSE route).
declare global {
  // eslint-disable-next-line no-var
  var __infiniteLoopEventBus: EventBus | undefined;
}

export const eventBus: EventBus =
  globalThis.__infiniteLoopEventBus ?? new EventBus();
if (!globalThis.__infiniteLoopEventBus) {
  globalThis.__infiniteLoopEventBus = eventBus;
}

export { EventBus };
