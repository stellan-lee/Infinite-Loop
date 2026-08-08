'use client';

import { useCallback, useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'infinite_loop:theme';

function readCurrentTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const t = document.documentElement.dataset.theme;
  return t === 'light' ? 'light' : 'dark';
}

export default function ThemeToggle() {
  // Start in 'light' on the server render so the markup is stable; the
  // pre-paint script in layout.tsx has already set the actual dataset.theme,
  // and we sync from it after mount.
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(readCurrentTheme());
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable; toggle is still effective for the session.
    }
  }, [theme]);

  // Glyph is drawn in CSS (half-disc) — see .theme-toggle-glyph in globals.css.
  // Which half is filled is controlled by `aria-pressed` so the JSX stays
  // declarative and the glyph alignment is independent of font metrics.
  const label = theme === 'dark' ? 'switch to light theme' : 'switch to dark theme';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={label}
      aria-pressed={theme === 'light'}
      title={label}
    >
      <span className="theme-toggle-glyph" aria-hidden="true" />
      <span className="theme-toggle-label">{theme}</span>
    </button>
  );
}
