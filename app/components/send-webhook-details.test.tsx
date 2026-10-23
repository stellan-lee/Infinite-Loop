import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import type { Workflow, WorkflowEvent } from '@/lib/shared/workflow';
import { availableVariables, lintWorkflowTemplates } from '@/lib/shared/template-refs';
import { webhookFailure, type SendWebhookConfig } from '@/lib/shared/send-webhook';
import ConfigPanel from './ConfigPanel';
import Palette from './Palette';
import SendWebhookNode from './canvas/nodes/SendWebhookNode';
import { webhookOutputForNode } from './send-webhook-details';
const config: SendWebhookConfig = { url: 'https://example.com/private-token?event=hidden', method: 'POST', body: '{"message":"{{source.stdout}}"}' };
const workflow: Workflow = { id: 'webhook-ui', name: 'Webhook', version: 1, createdAt: 1, updatedAt: 1, nodes: [
  { id: 'source', type: 'agent', position: { x: 0, y: 0 }, config: { providerId: 'fixture', prompt: 'hello', timeoutMs: 1000 } },
  { id: 'send', type: 'send-webhook', position: { x: 200, y: 0 }, config },
], edges: [{ id: 'source-send', source: 'source', sourceHandle: 'success', target: 'send' }] };
const nativeFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = Object.assign(async () => Response.json({ providers: [] }), nativeFetch);
  useWorkflowStore.setState({ currentWorkflow: structuredClone(workflow), selectedNodeId: 'send', runEvents: [], webhooks: {}, inspectedRunEvents: null, runStatus: 'idle' });
});
afterEach(() => { cleanup(); globalThis.fetch = nativeFetch; });
test('palette includes inert draggable Send Webhook and inspector edits config', async () => {
  await act(async () => { render(<Palette />); }); expect(screen.getByRole('button', { name: 'add send-webhook node' })).toHaveAttribute('draggable', 'true');
  await act(async () => { render(<ConfigPanel />); });
  fireEvent.change(screen.getByRole('textbox', { name: 'Webhook URL' }), { target: { value: 'https://example.com/new' } });
  expect((useWorkflowStore.getState().currentWorkflow!.nodes[1].config as SendWebhookConfig).url).toBe('https://example.com/new');
  expect(screen.getByRole('textbox', { name: 'Webhook JSON body' })).toHaveValue(config.body);
  expect(screen.getByRole('spinbutton', { name: 'Webhook maximum attempts' })).toHaveValue(1);
  expect(screen.queryByRole('button', { name: /test.*request/i })).toBeNull();
});
test('webhook outputs and body/header refs participate in existing template registry', () => {
  expect(availableVariables(workflow, 'next').some(ref => ref.ref === 'send.statusCode')).toBe(true);
  expect(lintWorkflowTemplates(workflow)).toEqual([]);
  const changed = structuredClone(workflow); (changed.nodes[1].config as SendWebhookConfig).headers = { 'X-Event': '{{missing.value}}' };
  expect(lintWorkflowTemplates(changed)).toContainEqual(expect.objectContaining({ field: 'headers.X-Event', ref: 'missing.value' }));
});
test('card displays safe destination, status and code; snapshots and history select separate results', () => {
  const output = { ...webhookFailure(config, 'http_status'), statusCode: 503 };
  useWorkflowStore.getState().hydrateRun({ status: 'running', events: [], webhooks: { send: output } });
  render(<ReactFlowProvider><SendWebhookNode {...({ id: 'send', data: { config }, selected: false, type: 'send-webhook', draggable: true, dragging: false, zIndex: 0, selectable: true, deletable: true, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 })} /></ReactFlowProvider>);
  expect(screen.getByText(/POST · https:\/\/example.com/)).toBeInTheDocument(); expect(screen.getByText('FAILED · HTTP 503')).toBeInTheDocument();
  expect(screen.queryByText(/private-token/)).toBeNull(); expect(screen.queryByText(/hidden/)).toBeNull();
  const historical: WorkflowEvent = { type: 'webhook_updated', nodeId: 'send', output: { ...output, status: 'SUCCEEDED', statusCode: 204 } };
  act(() => useWorkflowStore.getState().setInspectedRunEvents([historical]));
  expect(webhookOutputForNode(useWorkflowStore.getState(), 'send')?.statusCode).toBe(204);
  act(() => { useWorkflowStore.getState().setInspectedRunEvents(null); useWorkflowStore.getState().resetRun(); });
  expect(useWorkflowStore.getState().webhooks).toEqual({});
});
