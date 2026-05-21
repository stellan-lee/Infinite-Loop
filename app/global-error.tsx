'use client';

/*
 * App Router global error boundary.
 *
 * It replaces the root layout when the layout itself throws, so it must render
 * its own <html>/<body>. Supplying it also keeps `next build` from synthesizing
 * the legacy Pages-Router `/_error` page, whose prerender path trips a spurious
 * "<Html> should not be imported outside of pages/_document" prerender error.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: '100dvh',
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem',
          padding: '2rem',
          textAlign: 'center',
          background: '#2f2d29',
          color: '#f0ede4',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        <p style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
          Something went wrong
        </p>
        <p style={{ color: '#8e8a7e', margin: 0 }}>
          The console hit an unexpected error.
          {error.digest ? ` (ref: ${error.digest})` : ''}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 1rem',
            background: 'transparent',
            color: '#7dcfff',
            border: '1px solid rgba(240, 237, 228, 0.22)',
            borderRadius: '6px',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
