'use client';

import { type ReactNode } from 'react';
import { Checkbox as HeroCheckbox } from '@heroui/react';

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Thin HeroUI v3 adapter used by configuration controls and existing
 * shared consumers. Its public API stays stable while HeroUI supplies the
 * native checkbox semantics, keyboard behavior, and focus management. */
export default function Checkbox({
  checked,
  onChange,
  ariaLabel,
  label,
  disabled = false,
  className,
}: Props) {
  const classes = ['checkbox', className].filter(Boolean).join(' ');
  return (
    <HeroCheckbox
      className={classes}
      isSelected={checked}
      isDisabled={disabled}
      onChange={onChange}
      aria-label={label ? undefined : ariaLabel}
      variant="secondary"
    >
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        {label && <span className="checkbox-label">{label}</span>}
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}
