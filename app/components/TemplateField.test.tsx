import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';
import type { TemplateRef } from '@/lib/shared/template-refs';
import TemplateField from './TemplateField';

const refs: TemplateRef[] = [
  {
    ref: 'agent-1.stdout',
    nodeId: 'agent-1',
    field: 'stdout',
    kind: 'node',
    description: 'agent output',
    inScope: true,
  },
];

function ControlledTemplateField() {
  const [value, setValue] = useState('{{');
  return (
    <TemplateField
      ariaLabel="Prompt"
      value={value}
      onChange={setValue}
      selfId="agent-2"
      refs={refs}
      fieldPath="prompt"
    />
  );
}

test('TemplateField preserves autocomplete insertion and caret behavior with HeroUI Input', () => {
  render(<ControlledTemplateField />);

  const input = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLInputElement;
  act(() => {
    fireEvent.focus(input);
    input.setSelectionRange(2, 2);
    fireEvent.select(input);
  });

  expect(screen.getByRole('listbox', { name: 'Available template variables' })).toBeInTheDocument();
  act(() => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });

  expect(input.value).toBe('{{ agent-1.stdout }}');
});
