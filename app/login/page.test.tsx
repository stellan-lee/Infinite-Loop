import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from './page';

const originalFetch = globalThis.fetch;
const originalAssign = window.location.assign;

let assignMock: ReturnType<typeof mock>;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  assignMock = mock(() => {});
  window.location.assign = assignMock as unknown as typeof window.location.assign;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.location.assign = originalAssign;
});

/** Mock fetch: GET /api/auth returns `status`; POST /api/auth returns `login`. */
function mockFetch(status: {
  authRequired?: boolean;
  authenticated?: boolean;
}, login?: { ok: boolean; status?: number }) {
  globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return login?.ok
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: 'invalid token' }, login?.status ?? 401);
    }
    return jsonResponse(status);
  }) as unknown as typeof fetch;
}

describe('LoginPage', () => {
  it('redirects to the console when auth is not required', async () => {
    mockFetch({ authRequired: false });
    render(<LoginPage />);
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/'));
  });

  it('redirects when the browser is already authenticated', async () => {
    mockFetch({ authRequired: true, authenticated: true });
    render(<LoginPage />);
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/'));
  });

  it('shows the token form when auth is required and not authenticated', async () => {
    mockFetch({ authRequired: true, authenticated: false });
    render(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/api token/i)).toBeTruthy();
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('logs in and redirects on a correct token', async () => {
    mockFetch({ authRequired: true, authenticated: false }, { ok: true });
    render(<LoginPage />);
    const input = await waitFor(() => screen.getByLabelText(/api token/i));
    fireEvent.change(input, { target: { value: 'the-token' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const postCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      token: 'the-token',
    });
  });

  it('shows an error and does not redirect on an invalid token', async () => {
    mockFetch({ authRequired: true, authenticated: false }, { ok: false, status: 401 });
    render(<LoginPage />);
    const input = await waitFor(() => screen.getByLabelText(/api token/i));
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/not valid/i);
    });
    expect(assignMock).not.toHaveBeenCalled();
  });
});
