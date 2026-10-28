'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { registerWorkflowEditor } from '../../../lib/client/workflow-navigation';

export const DEBOUNCE_MS = 200;

export function useDebouncedString(
  initial: string,
  onCommit: (next: string) => void,
  delay = DEBOUNCE_MS,
): [string, (value: string) => void] {
  const [value, setValue] = useState(initial);
  const latestValue = useRef(initial);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const lastInitial = useRef(initial);
  useEffect(() => {
    if (initial !== lastInitial.current) {
      lastInitial.current = initial;
      latestValue.current = initial;
      setValue(initial);
    }
  }, [initial]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const set = useCallback(
    (next: string) => {
      setValue(next);
      latestValue.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        onCommitRef.current(next);
      }, delay);
    },
    [delay],
  );

  useEffect(() => {
    const commitPending = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      onCommitRef.current(latestValue.current);
    };
    const unregister = registerWorkflowEditor(commitPending);
    return () => {
      commitPending();
      unregister();
    };
  }, []);

  return [value, set];
}

export type TimeoutUnit = 's' | 'min' | 'hr';

export const TIMEOUT_UNIT_MS: Record<TimeoutUnit, number> = {
  s: 1000,
  min: 60_000,
  hr: 3_600_000,
};

export const TIMEOUT_UNITS: ReadonlyArray<TimeoutUnit> = ['s', 'min', 'hr'];

export function pickInitialTimeoutUnit(ms: number): TimeoutUnit {
  if (ms >= TIMEOUT_UNIT_MS.hr && ms % TIMEOUT_UNIT_MS.hr === 0) return 'hr';
  if (ms >= TIMEOUT_UNIT_MS.min && ms % TIMEOUT_UNIT_MS.min === 0) return 'min';
  return 's';
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="segmented">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            data-active={value === opt.value}
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
