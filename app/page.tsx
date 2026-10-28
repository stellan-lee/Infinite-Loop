import { guardPage } from '@/lib/server/page-guard';
import FlowList from './FlowList';

/**
 * Server-component shell for the console. It runs the auth gate before any
 * client code: when `INFLOOP_API_TOKEN` is set and the request carries no
 * valid session cookie, `guardPage()` redirects to `/login`. Otherwise it
 * hands off to the flow list client component.
 */
export default async function Page() {
  await guardPage();
  return <FlowList />;
}
