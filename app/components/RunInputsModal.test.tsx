import { describe, expect, it, mock, afterEach } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import RunInputsModal from './RunInputsModal';
import type { WorkflowInputDecl } from '@/lib/shared/workflow';

const decls = (inputs: WorkflowInputDecl[]): WorkflowInputDecl[] => inputs;

afterEach(() => {
  cleanup();
});

describe('RunInputsModal', () => {
  it('renders one field per declared input with type-appropriate widget', () => {
    render(
      <RunInputsModal
        declared={decls([
          { name: 'topic', type: 'string', default: 'cats' },
          { name: 'count', type: 'number' },
          { name: 'enabled', type: 'boolean', default: true },
          { name: 'notes', type: 'text' },
        ])}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText('topic')).toBeInTheDocument();
    expect(screen.getByLabelText('count')).toBeInTheDocument();
    expect(screen.getByLabelText('enabled')).toBeInTheDocument();
    expect(screen.getByLabelText('notes')).toBeInTheDocument();
    expect(screen.getByLabelText('topic')).toHaveValue('cats');
  });

  it('blocks submit when a required field is empty', () => {
    const onSubmit = mock(() => {});
    render(
      <RunInputsModal
        declared={decls([{ name: 'topic', type: 'string' }])}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /run/i }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/required/i)).toBeInTheDocument();
  });

  it('submits typed values on Run', () => {
    const onSubmit = mock((_v: Record<string, unknown>) => {});
    render(
      <RunInputsModal
        declared={decls([
          { name: 'topic', type: 'string' },
          { name: 'count', type: 'number' },
        ])}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    act(() => {
      fireEvent.change(screen.getByLabelText('topic'), {
        target: { value: 'dogs' },
      });
    });
    act(() => {
      fireEvent.change(screen.getByLabelText('count'), {
        target: { value: '7' },
      });
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /run/i }));
    });
    expect(onSubmit).toHaveBeenCalledWith({ topic: 'dogs', count: 7 });
  });


  it('keeps action buttons outside the scrollable field body for long forms', () => {
    render(
      <RunInputsModal
        declared={decls([
          { name: 'projectPath', type: 'string', default: '/tmp/project' },
          { name: 'task', type: 'text', default: 'do work' },
          { name: 'constraints', type: 'text', default: 'be safe' },
          { name: 'verificationCommand', type: 'string', default: 'bun test' },
          { name: 'providerId', type: 'string', default: 'claude' },
          { name: 'implementationAgent', type: 'string', default: '' },
          { name: 'techLeadAgent', type: 'string', default: 'senior-review-agent' },
          { name: 'seniorReviewerAgent', type: 'string', default: 'code-review-agent' },
        ])}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    const fieldBody = screen.getByLabelText('workflow input fields');
    expect(fieldBody).toHaveClass('modal-body');
    expect(fieldBody).toContainElement(screen.getByLabelText('projectPath'));
    expect(fieldBody).not.toContainElement(screen.getByRole('button', { name: /run/i }));
    expect(screen.getByRole('group', { name: /workflow input actions/i })).toHaveClass('modal-actions');
  });

  it('calls onCancel when Cancel clicked', () => {
    const onCancel = mock(() => {});
    render(
      <RunInputsModal
        declared={decls([])}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
