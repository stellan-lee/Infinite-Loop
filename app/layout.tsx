import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

const newsreader = localFont({
  src: [
    { path: './fonts/newsreader/Newsreader-Regular.ttf', weight: '300 600', style: 'normal' },
    { path: './fonts/newsreader/Newsreader-Italic.ttf', weight: '300 600', style: 'italic' },
  ],
  variable: '--font-serif',
  adjustFontFallback: 'Times New Roman',
  display: 'swap',
});

const jetbrains = localFont({
  src: './fonts/jetbrainsmono/JetBrainsMono-Regular.ttf',
  variable: '--font-mono',
  weight: '300 700',
  style: 'normal',
  adjustFontFallback: 'Arial',
  display: 'swap',
});

export const metadata = {
  title: 'Infinite Loop · Console',
  description: 'Visual orchestration for AI agents — loop, branch, fan out, and replay.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${jetbrains.variable}`}
      // The Google Newsreader face used optical size 16; Mono ignores this unsupported axis.
      style={{ fontVariationSettings: '"opsz" 16' }}
      suppressHydrationWarning
    >
      <head>
        {/*
         * Pre-paint theme application — must run before <body> renders to
         * avoid a flash of the wrong theme. Reads the user's saved choice
         * (`infinite_loop:theme`), falling back to the editor's light
         * workspace theme. The toggle still provides an explicit dark mode.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('infinite_loop:theme');document.documentElement.dataset.theme=s==='dark'?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`,
          }}
        />
      </head>
      {/*
       * Browser extensions like ColorZilla inject attributes such as
       * `cz-shortcut-listen="true"` onto <body> before React hydrates,
       * which causes a benign-but-noisy hydration warning. We don't
       * render any attribute-sensitive content on these elements, so
       * suppressing the warning here is the canonical React fix.
       */}
      <body suppressHydrationWarning>
        <div className="grain" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
