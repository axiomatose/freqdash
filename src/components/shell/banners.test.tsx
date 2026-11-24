// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindingsBannerView } from './FindingsBanner';
import { ModeBannerView } from './ModeBanner';
import { MonitorIndicatorView } from './MonitorIndicator';

afterEach(cleanup);

describe('FindingsBannerView', () => {
  it('renders nothing when there are no critical or warning findings', () => {
    const { container } = render(<FindingsBannerView critical={0} warning={0} top={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('critical wins over warnings, names the count and the top finding, and links to /findings', () => {
    render(
      <FindingsBannerView critical={2} warning={1} top={{ title: 'Orphan Kraken orders on ETH/USD (26 · $293.70)' }} />,
    );
    const banner = screen.getByRole('region', { name: 'Findings' });
    expect(banner.dataset.severity).toBe('critical');
    expect(banner.textContent).toContain('2 critical');
    expect(banner.textContent).toContain('Orphan Kraken orders on ETH/USD (26 · $293.70)');
    expect(banner.textContent).toContain('+1 warning');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/findings');
  });

  it('warnings only are amber and pluralised', () => {
    render(<FindingsBannerView critical={0} warning={3} top={{ title: 'x' }} />);
    const banner = screen.getByRole('region', { name: 'Findings' });
    expect(banner.dataset.severity).toBe('warning');
    expect(banner.textContent).toContain('3 warnings');
  });
});

describe('ModeBannerView', () => {
  it('explains freqtrade-only mode, links to the Kraken setup and dismisses', async () => {
    const onDismiss = vi.fn();
    render(<ModeBannerView reason="No Kraken key" onDismiss={onDismiss} />);
    expect(screen.getByRole('note').textContent).toContain('No Kraken key:');
    expect(screen.getByRole('link', { name: /Kraken setup/ }).getAttribute('href')).toBe('/status#kraken');
    await userEvent.click(screen.getByRole('button', { name: 'Hide for 24 hours' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no dismiss button without a handler and defaults the reason', () => {
    render(<ModeBannerView reason={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('No Kraken key:');
  });
});

describe('MonitorIndicatorView', () => {
  const now = 1_800_000_000_000;

  it('live: says Live and how long ago the checks ran', () => {
    render(<MonitorIndicatorView state="live" checkedAt={now - 12_000} now={now} />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(document.body.textContent).toContain('checked 12 s ago');
  });

  it('compact live drops the word "checked"', () => {
    render(<MonitorIndicatorView state="live" checkedAt={now - 12_000} now={now} compact />);
    expect(document.body.textContent).toContain('12 s ago');
    expect(document.body.textContent).not.toContain('checked');
  });

  it('stalled and offline are text, not just colour', () => {
    const { rerender } = render(<MonitorIndicatorView state="stalled" checkedAt={now - 90_000} now={now} />);
    expect(screen.getByText('Monitoring stalled')).toBeTruthy();
    rerender(<MonitorIndicatorView state="offline" checkedAt={null} now={now} />);
    expect(screen.getByText('Offline')).toBeTruthy();
  });
});
