'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import FlowList from './FlowList';

/** This layout survives transitions between the index and a workflow URL. */
export default function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const flowId = pathname === '/' ? null : decodeURIComponent(pathname.slice(1));
  return <FlowList flowId={flowId}>{children}</FlowList>;
}
