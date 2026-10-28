'use client';

import { useEffect, useRef, useState } from 'react';
import type { PluginField } from '@/lib/shared/trigger';
import { useViewportPopover } from './useViewportPopover';

export interface FieldPickerProps {
  fields: PluginField[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export function FieldPicker({
  fields,
  value,
  onChange,
  placeholder = '{{body.something}}',
  ariaLabel,
}: FieldPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, panelStyle, portal } = useViewportPopover<HTMLUListElement>(open && fields.length > 0, containerRef, { maxHeight: 220 });

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Filter fields by current typed text (case-insensitive substring on path/description).
  const filter = value.replace(/[{}]/g, '').toLowerCase();
  const visible = filter.length === 0
    ? fields
    : fields.filter((f) => f.path.toLowerCase().includes(filter) || (f.description ?? '').toLowerCase().includes(filter));

  const looksLikeTemplate = /^\{\{.+\}\}$/.test(value.trim());
  const inSchema = fields.some((f) => `{{${f.path}}}` === value.trim());
  const notInSchema = looksLikeTemplate && fields.length > 0 && !inSchema;

  return (
    <div className="fp-root" ref={containerRef}>
      <div className="fp-input-row">
        <input
          className="fp-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          aria-label={ariaLabel}
          placeholder={placeholder}
        />
        {notInSchema && (
          <span
            className="fp-warning"
            title="This path is not in the plugin's declared schema. The trigger will still evaluate it at runtime."
          >
            ⚠
          </span>
        )}
      </div>
      {open && fields.length > 0 && portal(
        <ul ref={panelRef} style={panelStyle} className="fp-menu" role="listbox">
          {visible.map((f) => (
            <li
              key={f.path}
              className="fp-option"
              role="option"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(`{{${f.path}}}`);
                setOpen(false);
              }}
            >
              <span className="fp-option-path">{f.path}</span>
              {f.description ? (
                <span className="fp-option-desc">{f.description}</span>
              ) : null}
            </li>
          ))}
          {visible.length === 0 && (
            <li className="fp-option fp-option-empty">No matching field — using your typed value.</li>
          )}
        </ul>
      )}
    </div>
  );
}
