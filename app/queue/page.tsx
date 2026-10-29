import { guardPage } from '@/lib/server/page-guard';
import QueueView from './QueueView';

/**
 * Server-component shell for the trigger-queue page. Runs the auth gate
 * before handing off to the `QueueView` client component.
 */
export default async function QueuePage() {
  await guardPage();
  return <QueueView />;
}
