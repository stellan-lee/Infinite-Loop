'use client';

import { createContext, useContext, type RefObject } from 'react';

export interface ConsoleLayoutState {
  flowId: string | null;
  navigate: (href: string, replace?: boolean) => Promise<void>;
  navigating: boolean;
  navigationError: string | null;
  reportWorkspace: (id: string, state: 'loading' | 'ready' | 'error') => void;
  transitioning: boolean;
  drawerOpen: boolean;
  openDrawer: () => void;
  drawerToggleRef: RefObject<HTMLButtonElement | null>;
}

export const ConsoleLayoutContext = createContext<ConsoleLayoutState | null>(null);
export const useConsoleLayout = () => useContext(ConsoleLayoutContext);
