'use client';

import { useId } from 'react';

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}

/** Styled checkbox that replaces native `<input type="checkbox">` for
 *  primary UI controls — a `<button role="checkbox">` whose visual is
 *  driven by the `[data-checked]` attribute. When `label` is provided
 *  the label text is wired to the button via `aria-labelledby` (rather
 *  than `<label htmlFor>`, which the HTML spec doesn't define for
 *  `<button>`), and clicking the label text toggles via the wrapper's
 *  onClick. */
export default function Checkbox({
  checked,
  onChange,
  ariaLabel,
  label,
  disabled = false,
  className,
}: Props) {
  const id = useId();
  const labelId = `${id}-label`;
  const classes = ['checkbox', className].filter(Boolean).join(' ');
  const toggle = () => { if (!disabled) onChange(!checked); };
  const box = (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      disabled={disabled}
      className="checkbox-box"
      data-checked={checked}
      onClick={(e) => {
        // Stop propagation so the wrapper span's onClick (when label is
        // provided) doesn't also fire and cancel the toggle.
        e.stopPropagation();
        toggle();
      }}
      onKeyDown={(e) => {
        // Native <button> already fires `click` on Space and Enter; we
        // only intercept Space to suppress the default page-scroll.
        if (e.key === ' ') e.preventDefault();
      }}
    >
      <span className="checkbox-mark" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
    </button>
  );
  if (!label) return <span className={classes}>{box}</span>;
  return (
    <span className={classes} onClick={toggle}>
      {box}
      <span id={labelId} className="checkbox-label">{label}</span>
    </span>
  );
}
