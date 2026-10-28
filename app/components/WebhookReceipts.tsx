'use client';

import { useEffect, useRef, useState } from 'react';
import type { WebhookReceipt, WebhookReceiptSummary, WebhookReceiptState } from '@/lib/shared/webhook-receipt';
import type { WebhookTrigger } from '@/lib/shared/trigger';
import styles from './WebhookReceipts.module.css';

interface Props {
  workflowFilter: string | null;
  triggerFilter: string | null;
  onTriggerFilterChange: (id: string | null) => void;
  triggers: WebhookTrigger[];
}

interface Page {
  receipts: WebhookReceiptSummary[];
  nextCursor: string | null;
}

const ACTIVE_STATES: WebhookReceiptState[] = ['received', 'queued', 'running'];

function stateLabel(state: WebhookReceiptState): string {
  switch (state) {
    case 'received': return 'Received';
    case 'queued': return 'Queued';
    case 'running': return 'Running';
    case 'succeeded': return 'Succeeded';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'ignored': return 'Ignored';
    case 'rejected': return 'Rejected';
    case 'dropped': return 'Dropped';
    case 'removed': return 'Removed';
  }
}

function responseError(status: number): Error {
  return new Error(`Could not load messages (HTTP ${status}).`);
}

export function WebhookReceipts({ workflowFilter, triggerFilter, onTriggerFilterChange, triggers }: Props) {
  const [page, setPage] = useState<Page | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WebhookReceipt | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderLoaded, setOlderLoaded] = useState(false);
  const pageRef = useRef<Page | null>(null);
  const filterKey = `${workflowFilter ?? ''}\u0000${triggerFilter ?? ''}`;
  const activeFilter = useRef(filterKey);
  const olderRequest = useRef<AbortController | null>(null);
  const olderExhausted = useRef(false);
  activeFilter.current = filterKey;
  pageRef.current = page;

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let current: AbortController | null = null;
    setPage(null);
    setListError(null);
    setSelectedId(null);
    setReceipt(null);
    setOlderLoaded(false);
    setLoadingOlder(false);
    olderExhausted.current = false;

    const loadLatest = async () => {
      if (busy) return;
      busy = true;
      const controller = new AbortController();
      current = controller;
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (workflowFilter) params.set('workflowId', workflowFilter);
        if (triggerFilter) params.set('triggerId', triggerFilter);
        const response = await fetch(`/api/webhook-receipts?${params}`, { signal: controller.signal });
        if (!response.ok) throw responseError(response.status);
        const latest = await response.json() as Page;
        if (disposed) return;
        const latestIds = new Set(latest.receipts.map((entry) => entry.id));
        const previousPage = pageRef.current;
        const loadedIds = new Set(previousPage?.receipts.map((entry) => entry.id));
        const hasGap = !!previousPage?.receipts.length && latest.receipts.length > 0 &&
          !latest.receipts.some((entry) => loadedIds.has(entry.id));
        if (hasGap) {
          // More than one page arrived between polls. Restart pagination at
          // the new page's boundary so Load older can reach the missing rows.
          olderRequest.current?.abort();
          olderExhausted.current = false;
          setOlderLoaded(false);
          setLoadingOlder(false);
        }
        const olderActive = pageRef.current?.receipts.filter((entry) =>
          ACTIVE_STATES.includes(entry.state) && !latestIds.has(entry.id)) ?? [];
        setPage((previous) => {
          if (!previous) return latest;
          const byId = new Map(previous.receipts.map((entry) => [entry.id, entry]));
          for (const entry of latest.receipts) {
            const existing = byId.get(entry.id);
            if (!existing || entry.updatedAt >= existing.updatedAt) byId.set(entry.id, entry);
          }
          const receipts = [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
          return { receipts, nextCursor: hasGap ? latest.nextCursor : olderExhausted.current ? null : previous.nextCursor ?? latest.nextCursor };
        });
        // The newest page no longer contains loaded older receipts. Refresh
        // any that are still active so their displayed state can settle.
        let next = 0;
        let refreshFailed = false;
        const updates = new Map<string, WebhookReceiptSummary>();
        await Promise.all(Array.from({ length: Math.min(4, olderActive.length) }, async () => {
          while (next < olderActive.length && !controller.signal.aborted) {
            const entry = olderActive[next++];
            try {
              const response = await fetch(`/api/webhook-receipts/${encodeURIComponent(entry.id)}`, { signal: controller.signal });
              if (!response.ok) throw responseError(response.status);
              const data = await response.json() as { receipt: WebhookReceipt };
              const { body: _body, result: _result, ...summary } = data.receipt;
              updates.set(entry.id, summary);
            } catch {
              if (!controller.signal.aborted) refreshFailed = true;
            }
          }
        }));
        if (disposed) return;
        if (updates.size) setPage((previous) => previous && ({
          ...previous,
          receipts: previous.receipts.map((entry) => {
            const updated = updates.get(entry.id);
            return updated && updated.updatedAt >= entry.updatedAt ? updated : entry;
          }),
        }));
        if (refreshFailed) throw new Error('Could not refresh some running messages.');
        setListError(null);
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setListError((error as Error).message);
      } finally {
        if (current === controller) current = null;
        busy = false;
      }
    };

    void loadLatest();
    const timer = setInterval(() => { void loadLatest(); }, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
      current?.abort();
      olderRequest.current?.abort();
    };
  }, [workflowFilter, triggerFilter]);

  useEffect(() => {
    if (!selectedId) {
      setReceipt(null);
      setDetailError(null);
      return;
    }
    let disposed = false;
    let busy = false;
    let current: AbortController | null = null;
    setReceipt(null);
    setDetailError(null);
    const loadDetail = async () => {
      if (busy) return;
      busy = true;
      const controller = new AbortController();
      current = controller;
      try {
        const response = await fetch(`/api/webhook-receipts/${encodeURIComponent(selectedId)}`, { signal: controller.signal });
        if (!response.ok) throw responseError(response.status);
        const data = await response.json() as { receipt: WebhookReceipt };
        if (disposed) return;
        setReceipt(data.receipt);
        setDetailError(null);
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setDetailError((error as Error).message);
      } finally {
        if (current === controller) current = null;
        busy = false;
      }
    };
    void loadDetail();
    const timer = setInterval(() => { void loadDetail(); }, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
      current?.abort();
    };
  }, [selectedId]);

  async function loadOlder() {
    if (!page?.nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    const requestFilter = filterKey;
    const controller = new AbortController();
    olderRequest.current = controller;
    try {
      const params = new URLSearchParams({ limit: '50', before: page.nextCursor });
      if (workflowFilter) params.set('workflowId', workflowFilter);
      if (triggerFilter) params.set('triggerId', triggerFilter);
      const response = await fetch(`/api/webhook-receipts?${params}`, { signal: controller.signal });
      if (!response.ok) throw responseError(response.status);
      const older = await response.json() as Page;
      if (controller.signal.aborted || activeFilter.current !== requestFilter) return;
      olderExhausted.current = older.nextCursor === null;
      setPage((previous) => {
        if (!previous) return older;
        const byId = new Map(previous.receipts.map((entry) => [entry.id, entry]));
        for (const entry of older.receipts) {
          const existing = byId.get(entry.id);
          if (!existing || entry.updatedAt >= existing.updatedAt) byId.set(entry.id, entry);
        }
        return {
          receipts: [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id)),
          nextCursor: older.nextCursor,
        };
      });
      setOlderLoaded(true);
      setListError(null);
    } catch (error) {
      if (!controller.signal.aborted && activeFilter.current === requestFilter) setListError((error as Error).message);
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      if (!controller.signal.aborted && activeFilter.current === requestFilter) setLoadingOlder(false);
    }
  }

  const selectedSummary = page?.receipts.find((entry) => entry.id === selectedId);
  const selectedReceipt = receipt?.id === selectedId ? receipt : null;
  const detailState = selectedSummary && selectedReceipt && selectedSummary.updatedAt > selectedReceipt.updatedAt
    ? selectedSummary.state
    : selectedReceipt?.state ?? selectedSummary?.state;
  const showResult = selectedReceipt && !ACTIVE_STATES.includes(selectedReceipt.state) && selectedReceipt.result !== undefined;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <label htmlFor="dispatch-trigger-filter">Trigger</label>
        <select id="dispatch-trigger-filter" value={triggerFilter ?? ''} onChange={(event) => onTriggerFilterChange(event.target.value || null)}>
          <option value="">All triggers</option>
          {triggerFilter && !triggers.some((item) => item.id === triggerFilter) && <option value={triggerFilter}>{triggerFilter}</option>}
          {triggers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
        {workflowFilter && <span className={styles.filterNote}>Workflow: {workflowFilter}</span>}
      </div>
      {listError && <p role="alert" className={styles.error}>{listError}</p>}
      <div className={styles.split}>
        <section className={styles.list} aria-label="Received webhook messages">
          {page === null ? <p className={styles.empty}>Loading messages…</p> : page.receipts.length === 0 && !listError ? (
            <p className={styles.empty}>No webhook messages received.</p>
          ) : page.receipts.map((item) => (
            <button type="button" key={item.id} className={`${styles.message} ${selectedId === item.id ? styles.selected : ''}`} onClick={() => setSelectedId(item.id)} aria-pressed={selectedId === item.id}>
              <span className={styles.messageTop}><span className={styles.from}>{item.source}{item.sender ? ` · ${item.sender}` : ''}</span><span className={styles.status} data-state={item.state}>{stateLabel(item.state)}</span></span>
              <span className={styles.messageMeta}>{new Date(item.receivedAt).toLocaleString()}</span>
              <span className={styles.messageMeta}>Trigger: {item.triggerName ?? item.triggerId}</span>
              <span className={styles.messageMeta}>Workflow: {item.workflowName ?? item.workflowId ?? '—'}</span>
            </button>
          ))}
          {page?.nextCursor && <button type="button" className={styles.more} disabled={loadingOlder} onClick={() => { void loadOlder(); }}>{loadingOlder ? 'Loading…' : 'Load older'}</button>}
          {olderLoaded && !page?.nextCursor && <p className={styles.empty}>All older messages loaded.</p>}
        </section>
        <section className={styles.detail} aria-label="Webhook message details">
          {!selectedId ? <p className={styles.empty}>Select a message to see its request and workflow result.</p> : (
            <>
              {detailError && <p role="alert" className={styles.error}>{detailError}</p>}
              {!selectedReceipt ? !detailError && <p className={styles.empty}>Loading message…</p> : (
                <>
                  <div className={styles.detailHead}><h3>{selectedReceipt.source}{selectedReceipt.sender ? ` · ${selectedReceipt.sender}` : ''}</h3><span className={styles.status} data-state={detailState}>{stateLabel(detailState ?? selectedReceipt.state)}</span></div>
                  <dl className={styles.facts}>
                    <dt>Received</dt><dd>{new Date(selectedReceipt.receivedAt).toLocaleString()}</dd>
                    <dt>Trigger</dt><dd>{selectedReceipt.triggerName ?? selectedReceipt.triggerId}</dd>
                    <dt>Workflow</dt><dd>{selectedReceipt.workflowName ?? selectedReceipt.workflowId ?? '—'}</dd>
                    {selectedReceipt.httpStatus !== undefined && <><dt>HTTP status</dt><dd>{selectedReceipt.httpStatus}</dd></>}
                    {selectedReceipt.reason && <><dt>Reason</dt><dd>{selectedReceipt.reason}</dd></>}
                    {selectedReceipt.runId && <><dt>Run</dt><dd>{selectedReceipt.runId}</dd></>}
                  </dl>
                  <h4>Request body</h4>
                  {selectedReceipt.bodyUnavailable && <p className={styles.note}>Request body unavailable.</p>}
                  {selectedReceipt.bodyTruncated && <p className={styles.note}>Request body truncated at the capture limit.</p>}
                  {(!selectedReceipt.bodyUnavailable || selectedReceipt.body) && <pre className={styles.code}>{selectedReceipt.body || '(empty body)'}</pre>}
                  {detailState === 'running' ? <p className={styles.note}>Workflow running…</p> : detailState === 'queued' ? <p className={styles.note}>Workflow queued…</p> : detailState === 'received' ? <p className={styles.note}>Message received…</p> : (
                    <>
                      {selectedReceipt.errorMessage && <><h4>Workflow error</h4><pre className={styles.code}>{selectedReceipt.errorMessage}</pre></>}
                      {showResult && <><h4>Workflow result</h4><pre className={styles.code}>{JSON.stringify(selectedReceipt.result, null, 2)}</pre></>}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
