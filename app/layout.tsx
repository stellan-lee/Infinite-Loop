import type { ReactNode } from 'react';
import { Newsreader, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-serif',
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['300', '400', '500', '700'],
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
