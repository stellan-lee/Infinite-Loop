import type { Scope } from './workflow';

export type WebhookReceiptState =
  | 'received'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ignored'
  | 'rejected'
  | 'dropped'
  | 'removed';

/** One HTTP delivery to a Dispatch trigger, including deliveries that did not run. */
export interface WebhookReceipt {
  /** The ingress correlation ID. */
  id: string;
  receivedAt: number;
  updatedAt: number;
  /** Process that accepted this delivery; used only for restart reconciliation. */
  serverPid?: number;
  /** Run IDs displaced by queue replay; old completion events must not settle the retry. */
  supersededRunIds?: string[];
  triggerId: string;
  triggerName?: string;
  source: string;
  /** Sender claimed by the source payload; it has not been independently verified. */
  sender?: string;
  workflowId?: string;
  workflowName?: string;
  state: WebhookReceiptState;
  body: string;
  bodyTruncated?: boolean;
  bodyUnavailable?: boolean;
  contentType?: string;
  httpStatus?: number;
  reason?: string;
  queueId?: string;
  runId?: string;
  result?: Scope;
  errorMessage?: string;
}

/** List projection: potentially large body and result are only in detail. */
export type WebhookReceiptSummary = Omit<WebhookReceipt, 'body' | 'result' | 'serverPid' | 'supersededRunIds'>;
