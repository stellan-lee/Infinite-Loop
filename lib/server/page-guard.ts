import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME, isPageRequestAuthed } from './auth';

/**
 * Server-side gate for an authenticated page. Call it at the top of an authed
 * page's server component:
 *
 *   export default async function Page() {
 *     await guardPage();
 *     return <Workspace />;
 *   }
 *
 * When `INFLOOP_API_TOKEN` is set and the request carries no valid
 * `infloop_session` cookie, it redirects to `/login` before any client code
 * runs — so an unauthenticated visitor never sees a broken, data-less app.
 * When no token is configured (open mode) it is a no-op.
 *
 * `redirect()` works by throwing a `NEXT_REDIRECT` signal that Next handles;
 * callers must not wrap this in a try/catch that swallows it.
 */
export async function guardPage(): Promise<void> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!isPageRequestAuthed(session)) {
    redirect('/login');
  }
}
