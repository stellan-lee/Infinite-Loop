import type { Workflow } from '../shared/workflow';

export async function createWorkflow(): Promise<Workflow> {
  const now = Date.now();
  const body: Workflow = {
    id: `workflow-${now}`,
    name: 'Untitled',
    version: 1,
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 80, y: 200 }, config: {} },
      { id: 'end-1', type: 'end', position: { x: 520, y: 200 }, config: { outcome: 'succeeded' } },
    ],
    edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
    createdAt: now,
    updatedAt: now,
  };
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  const data = (await res.json()) as { workflow?: Workflow };
  if (!data.workflow?.id) throw new Error('malformed create response');
  return data.workflow;
}
