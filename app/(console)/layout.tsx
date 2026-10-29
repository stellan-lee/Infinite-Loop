import type { ReactNode } from 'react';
import { guardPage } from '@/lib/server/page-guard';
import ConsoleShell from '../ConsoleShell';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await guardPage();
  return <ConsoleShell>{children}</ConsoleShell>;
}
