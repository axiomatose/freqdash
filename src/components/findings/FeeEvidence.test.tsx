// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeeEvidence, formatRate, isFeeOrders } from './FeeEvidence';

afterEach(cleanup);

const order = {
  orderId: 'OORUYZ-2BWGK-SAYX6T',
  reasons: ['bot_fee_differs_from_kraken'],
  botRate: 0.0026,
  krakenRate: 0.004,
  expectedTaker: 0.004,
  expectedSource: 'kraken-tier',
  at: 1_790_000_000_000,
};

describe('FeeEvidence', () => {
  it('shows the reason, both rates and the expected tier with its source', () => {
    render(<FeeEvidence orders={[order]} />);
    expect(screen.getByText("The bot's fee rate differs from what Kraken charged")).toBeTruthy();
    expect(screen.getByText('0.260%')).toBeTruthy();
    expect(screen.getAllByText(/0\.400%/).length).toBe(2);
    expect(screen.getByText('(your Kraken fee tier)')).toBeTruthy();
  });

  it('says so when the expected rate is the built-in fallback', () => {
    render(<FeeEvidence orders={[{ ...order, expectedSource: 'default', krakenRate: null }]} />);
    expect(screen.getByText(/built-in fallback/)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('falls back to the raw code for an unknown reason', () => {
    render(<FeeEvidence orders={[{ ...order, reasons: ['something_new'] }]} />);
    expect(screen.getByText('something_new')).toBeTruthy();
  });

  it('only treats orders with reasons as fee evidence', () => {
    expect(isFeeOrders([order])).toBe(true);
    expect(isFeeOrders([{ orderId: 'x', stakeUsd: 5 }])).toBe(false);
    expect(formatRate(0.0026)).toBe('0.260%');
    expect(formatRate(null)).toBe('—');
  });
});
