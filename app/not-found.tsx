import Link from 'next/link';

/*
 * App Router 404 page.
 *
 * Beyond being the page users see for an unmatched route, this file (together
 * with `global-error.tsx`) makes the App Router supply its own error/404
 * entries so `next build` does not fall back to synthesizing the legacy
 * Pages-Router `/_error` shell — the shell that trips the spurious
 * "<Html> should not be imported outside of pages/_document" prerender error.
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--fg)',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
      }}
    >
      <p style={{ fontSize: '2.5rem', fontWeight: 600, margin: 0 }}>404</p>
      <p style={{ color: 'var(--fg-dim)', margin: 0 }}>
        This page could not be found.
      </p>
      <Link
        href="/"
        style={{ color: 'var(--accent-info)', textDecoration: 'none' }}
      >
        Back to console
      </Link>
    </main>
  );
}
