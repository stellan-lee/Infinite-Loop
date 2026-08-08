import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';
import Checkbox from './Checkbox';

function ControlledCheckbox({ disabled = false }: { disabled?: boolean }) {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox
      checked={checked}
      disabled={disabled}
      label="Enable worktree"
      onChange={setChecked}
    />
  );
}

test('Checkbox keeps HeroUI checkbox toggle semantics', () => {
  render(<ControlledCheckbox />);

  const checkbox = screen.getByRole('checkbox', { name: 'Enable worktree' });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
});

test('Checkbox does not toggle when disabled', () => {
  render(<ControlledCheckbox disabled />);

  const checkbox = screen.getByRole('checkbox', { name: 'Enable worktree' });
  fireEvent.click(checkbox);
  expect(checkbox).not.toBeChecked();
});
