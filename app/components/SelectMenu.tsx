'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useViewportPopover } from './useViewportPopover';

export interface SelectMenuOption<V extends string> {
  value: V;
  label: string;
}

interface Props<V extends string> {
  value: V;
  options: ReadonlyArray<SelectMenuOption<V>>;
  onChange: (next: V) => void;
  ariaLabel?: string;
  className?: string;
}

/** Custom dropdown that replaces native `<select>`. The trigger is a
 * button; the popup is a `role="listbox"` panel with `role="option"`
 * buttons. Closes on outside click and on Escape. Built so the popup
 * inherits project styling rather than the browser-native list. */
export default function SelectMenu<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, panelStyle, portal } = useViewportPopover<HTMLDivElement>(open, rootRef, { maxHeight: 240 });
  const listboxId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const classes = ['select-menu', className].filter(Boolean).join(' ');

  return (
    <div ref={rootRef} className={classes}>
      <button
        type="button"
        className="select-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-menu-trigger-label">
          {current?.label ?? ''}
        </span>
        <span className="select-menu-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && portal(
        <div
          ref={panelRef}
          style={panelStyle}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="select-menu-panel"
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className="select-menu-item"
              data-active={opt.value === value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
