// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveTable, type Column } from './ResponsiveTable';

interface Row {
  id: string;
  pair: string;
  qty: number;
}
const rows: Row[] = [
  { id: 'a', pair: 'BTC/USD', qty: 1 },
  { id: 'b', pair: 'ETH/USD', qty: 2 },
];
const columns: Column<Row>[] = [
  { key: 'pair', header: 'Pair', cell: (r) => r.pair },
  { key: 'qty', header: 'Quantity', align: 'right', cell: (r) => <button type="button">{r.qty}</button> },
];

function setWidth(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(cleanup);

describe('ResponsiveTable', () => {
  it('renders a table at md and up', () => {
    setWidth(true);
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Positions" />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('columnheader', { name: 'Quantity' })).toBeTruthy();
  });

  it('renders cards below md: first column is the title, others are labelled fields', () => {
    setWidth(false);
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.queryByRole('table')).toBeNull();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('BTC/USD')).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText('Quantity')).toBeTruthy();
  });

  it('drops columns marked hidden from the card layout', () => {
    setWidth(false);
    const cols: Column<Row>[] = [...columns, { key: 'x', header: 'Secret', card: 'hidden', cell: () => 'nope' }];
    render(<ResponsiveTable columns={cols} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.queryByText('Secret')).toBeNull();
  });

  it('shows the empty node instead of an empty table', () => {
    setWidth(true);
    render(<ResponsiveTable columns={columns} rows={[]} rowKey={(r) => r.id} empty={<p>No open positions</p>} />);
    expect(screen.getByText('No open positions')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it.each([true, false])(
    'activates a row on click or Enter, but not when a control inside was clicked (wide=%s)',
    async (wide) => {
      setWidth(wide);
      const onRowClick = vi.fn();
      const user = userEvent.setup();
      render(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />);

      await user.click(screen.getByText('BTC/USD'));
      expect(onRowClick).toHaveBeenCalledTimes(1);
      expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);

      await user.click(screen.getByRole('button', { name: '2' }));
      expect(onRowClick).toHaveBeenCalledTimes(1);

      const target = screen.getByText('ETH/USD').closest('[tabindex="0"]') as HTMLElement;
      target.focus();
      await user.keyboard('{Enter}');
      expect(onRowClick).toHaveBeenCalledTimes(2);
      expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    },
  );

  it('renders expanded content only for expanded rows', () => {
    setWidth(true);
    render(
      <ResponsiveTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        isExpanded={(r) => r.id === 'b'}
        renderExpanded={(r) => <span>orders of {r.pair}</span>}
      />,
    );
    expect(screen.getByText('orders of ETH/USD')).toBeTruthy();
    expect(screen.queryByText('orders of BTC/USD')).toBeNull();
  });
});
