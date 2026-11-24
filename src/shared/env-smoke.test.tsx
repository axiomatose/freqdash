// @vitest-environment happy-dom
// Documents how component tests are set up: the docblock above selects happy-dom for this file only, JSX is
// compiled by @vitejs/plugin-react, and @testing-library/react is available. Cleanup is explicit (no vitest globals).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

function Greeting({ name }: { name: string }) {
  return <p data-testid="greeting">Hello {name}</p>;
}

afterEach(cleanup);

describe('component test environment', () => {
  it('renders JSX into a DOM', () => {
    render(<Greeting name="freqdash" />);
    expect(screen.getByTestId('greeting').textContent).toBe('Hello freqdash');
    expect(document.body.contains(screen.getByTestId('greeting'))).toBe(true);
  });
});
