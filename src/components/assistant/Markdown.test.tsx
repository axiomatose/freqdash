// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('does not strike through text between two single tildes ("about" markers)', () => {
    const { container } = render(
      <Markdown text="Bot positions: VoteMax: ~$116.45 (18.7%), from two open trades: BTC/USD ($39.07) and ETH/USD (~$77.38, opened ~14h ago)." />,
    );
    expect(container.querySelector('del, s')).toBeNull();
    expect(container.textContent).toContain('~$116.45 (18.7%)');
  });

  it('still strikes through ~~double~~ tildes', () => {
    const { container } = render(<Markdown text="this is ~~gone~~ now" />);
    expect(container.querySelector('del')?.textContent).toBe('gone');
  });
});
