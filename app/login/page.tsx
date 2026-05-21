'use client';

import { useEffect, useState, type FormEvent } from 'react';

type Phase = 'checking' | 'ready' | 'submitting';

/**
 * Login screen for the authenticated mode (`INFLOOP_API_TOKEN` set). The user
 * pastes the API token; the server verifies it and sets an httpOnly session
 * cookie, after which the regular console works normally.
 *
 * On mount it checks `/api/auth`: if auth isn't required, or the browser is
 * already authenticated, it sends the user straight to the console — so this
 * page can never strand a user who doesn't need it.
 */
export default function LoginPage() {
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/auth');
        if (res.ok) {
          const data = (await res.json()) as {
            authRequired?: boolean;
            authenticated?: boolean;
          };
          if (alive && (!data.authRequired || data.authenticated)) {
            window.location.assign('/');
            return;
          }
        }
      } catch {
        // Couldn't reach the status endpoint — fall through and show the form.
      }
      if (alive) setPhase('ready');
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase('submitting');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        // Full navigation so the server-side page gate re-runs with the
        // freshly-set cookie.
        window.location.assign('/');
        return;
      }
      setError(
        res.status === 401
          ? 'That token is not valid.'
          : 'Login failed — please try again.',
      );
    } catch {
      setError('Could not reach the server.');
    }
    setPhase('ready');
  }

  return (
    <main className="login-screen">
      {phase === 'checking' ? (
        <p className="login-checking">Checking…</p>
      ) : (
        <form className="login-card" onSubmit={onSubmit}>
          <h1 className="login-title">
            Inf·Loop<em>Console</em>
          </h1>
          <p className="login-sub">
            This console is protected. Enter the API token to continue.
          </p>
          <label className="login-label" htmlFor="login-token">
            API token
          </label>
          <input
            id="login-token"
            className="login-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn login-submit"
            disabled={phase === 'submitting' || token.length === 0}
          >
            {phase === 'submitting' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </main>
  );
}
