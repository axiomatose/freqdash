// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from './model';
import { ToolCard, brief } from './ToolCard';

afterEach(cleanup);
type Tool = Extract<ChatItem, { kind: 'tool' }>;
const tool = (over: Partial<Tool> = {}): Tool => ({
  kind: 'tool',
  id: 'c1',
  name: 'silence_finding',
  args: '{"id":1}',
  status: 'ok',
  summary: 'Done',
  approval: null,
  ...over,
});

describe('ToolCard', () => {
  it('shows a friendly name and expands to the arguments', () => {
    render(<ToolCard item={tool()} />);
    expect(screen.getByText('Silence finding')).toBeTruthy();
    expect(screen.queryByText(/"id": 1/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Silence finding/ }));
    expect(screen.getByText(/"id": 1/)).toBeTruthy();
  });

  it('asks for a decision and reports it', () => {
    const onDecide = vi.fn();
    const approval = {
      callId: 'c1',
      name: 'silence_finding',
      arguments: '{"id":1}',
      risk: 'write' as const,
      summary: 'Silence finding #1',
    };
    render(<ToolCard item={tool({ status: 'awaiting', approval })} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecide.mock.calls).toEqual([
      ['c1', 'approve'],
      ['c1', 'deny'],
    ]);
  });

  it('flags danger approvals', () => {
    const approval = {
      callId: 'c1',
      name: 'reset_killswitch',
      arguments: '{}',
      risk: 'danger' as const,
      summary: 'Reset the killswitch',
    };
    render(<ToolCard item={tool({ name: 'reset_killswitch', status: 'awaiting', approval })} onDecide={() => {}} />);
    expect(screen.getByText(/Needs your approval/)).toBeTruthy();
  });

  it('captions finished calls briefly instead of dumping JSON', () => {
    expect(brief(tool({ summary: '{"a":1}' }))).toBe('Done');
    expect(brief(tool({ summary: 'Silenced #3' }))).toBe('Silenced #3');
    expect(brief(tool({ status: 'error', summary: 'unknown bot' }))).toBe('unknown bot');
  });
});
