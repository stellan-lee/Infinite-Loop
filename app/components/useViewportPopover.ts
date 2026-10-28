'use client';

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const VIEWPORT_GAP = 8;
const ANCHOR_GAP = 4;

interface PopoverOptions {
  minWidth?: number;
  maxHeight?: number;
  align?: 'start' | 'end';
}

/** Place a floating panel in the viewport rather than inside a scrollport. */
export function useViewportPopover<T extends HTMLElement>(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  { minWidth = 0, maxHeight = 320, align = 'start' }: PopoverOptions = {},
) {
  const panelRef = useRef<T | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const update = () => {
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + VIEWPORT_GAP;
      const topEdge = (viewport?.offsetTop ?? 0) + VIEWPORT_GAP;
      const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - VIEWPORT_GAP;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - VIEWPORT_GAP;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(0, Math.min(Math.max(rect.width, minWidth), rightEdge - leftEdge));
      const wantedLeft = align === 'end' ? rect.right - width : rect.left;
      const left = Math.max(leftEdge, Math.min(wantedLeft, rightEdge - width));
      // An anchor may be scrolled entirely out of view. Bound each side to
      // the visible viewport before choosing a side or calculating a cap.
      const below = Math.max(0, bottomEdge - Math.max(topEdge, rect.bottom + ANCHOR_GAP));
      const above = Math.max(0, Math.min(bottomEdge, rect.top - ANCHOR_GAP) - topEdge);
      const computed = getComputedStyle(panel);
      const borderHeight = (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
      const preferredHeight = Math.min(maxHeight, Math.max(panel.scrollHeight + borderHeight, panel.getBoundingClientRect().height));
      const openAbove = preferredHeight > below && above > below;
      const available = openAbove ? above : below;
      const height = Math.max(0, Math.min(maxHeight, available));
      const panelHeight = Math.min(preferredHeight, height);
      const wantedTop = openAbove ? rect.top - ANCHOR_GAP - panelHeight : rect.bottom + ANCHOR_GAP;
      const top = Math.max(topEdge, Math.min(wantedTop, bottomEdge - panelHeight));

      setPanelStyle((previous) => {
        if (previous.left === left && previous.top === top && previous.width === width && previous.maxHeight === height && previous.visibility === 'visible') return previous;
        return {
          position: 'fixed',
          inset: 'auto',
          left,
          top,
          right: 'auto',
          bottom: 'auto',
          width,
          minWidth: 0,
          maxWidth: Math.max(0, rightEdge - leftEdge),
          maxHeight: height,
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden',
          margin: 0,
          zIndex: 1100,
          visibility: 'visible',
        };
      });
    };

    update();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panel.contains(event.target)) return;
      update();
    };
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(anchor);
    observer?.observe(panel);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [open, anchorRef, minWidth, maxHeight, align]);

  return {
    panelRef,
    panelStyle,
    portal: (content: ReactNode) => typeof document === 'undefined' ? null : createPortal(content, document.body),
  };
}
