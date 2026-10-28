import { guardPage } from '@/lib/server/page-guard';
import Workspace from '../Workspace';

export default async function FlowPage({ params }: { params: Promise<{ flowId: string }> }) {
  await guardPage();
  const { flowId } = await params;
  return <Workspace key={flowId} flowId={flowId} />;
}
