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
 *  primary UI controls. The visual is a CSS-styled box driven off the
 *  `[data-checked]` attribute on a button; an aria role of "checkbox"
 *  keeps it accessible to screen readers and keyboard navigation (Space
 *  toggles, as on a native checkbox). When `label` is provided the box
 *  and label compose as a single click target via `<label htmlFor>` so
 *  the label text is the button's accessible name. The `<button>`'s
 *  onClick stops propagation, which is enough to prevent the historical
 *  "<button>-inside-<label> double-fire" quirk without dropping the
 *  semantic label association. */
export default function Checkbox({
  checked,
  onChange,
  ariaLabel,
  label,
  disabled = false,
  className,
}: Props) {
  const id = useId();
  const classes = ['checkbox', className].filter(Boolean).join(' ');
  const toggle = () => { if (!disabled) onChange(!checked); };
  const box = (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      className="checkbox-box"
      data-checked={checked}
      onClick={(e) => {
        // Stop propagation so the click doesn't also reach the wrapping
        // <label>, which would re-fire the toggle and cancel it out.
        e.stopPropagation();
        toggle();
      }}
      onKeyDown={(e) => {
        // Native <button> already fires `click` on Space and Enter, so
        // we only intercept Space to suppress the default page-scroll.
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
    <label className={classes} htmlFor={id}>
      {box}
      <span className="checkbox-label">{label}</span>
    </label>
  );
}
