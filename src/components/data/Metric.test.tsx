// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Freshness, FreshnessState } from '@/shared/types/domain';
import { resetPrefsCache, updatePrefs } from '@/lib/client/prefs';
import { FreshnessProvider } from './FreshnessProvider';
import { Metric } from './Metric';
import { Money } from './Numbers';

const NOW = Date.UTC(2026, 8, 28, 14, 32, 0);

function src(source: string, state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return {
    source,
    label: `Label ${source}`,
    cadenceMs: 30_000,
    lastOkAt: NOW - 12_000,
    lastAttemptAt: NOW - 3_000,
    consecutiveFailures: 0,
    error: null,
    state,
    ...over,
  };
}

const SOURCES: Freshness[] = [
  src('a:fresh', 'fresh'),
  src('a:aging', 'aging'),
  src('a:stale', 'stale', { lastOkAt: Date.UTC(2026, 8, 28, 14, 2, 0) }),
  src('a:error', 'error', {
    lastOkAt: Date.UTC(2026, 8, 28, 13, 50, 0),
    consecutiveFailures: 4,
    error: 'EAPI:Invalid nonce',
  }),
  src('a:off', 'disabled', { lastOkAt: null }),
];

function renderMetric(sources: string[], provider: { offline?: { since: number | null } } = {}) {
  return render(
    <FreshnessProvider sources={SOURCES} offline={provider.offline}>
      <Metric value={<Money value={622.78} />} sources={sources} />
    </FreshnessProvider>,
  );
}

const slot = (): HTMLElement => document.querySelector('[data-slot=metric]') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  resetPrefsCache();
  updatePrefs({ utc: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Metric', () => {
  it('shows the value with no dot when no source resolves', () => {
    renderMetric(['unknown:key']);
    expect(screen.getByText('$622.78')).toBeTruthy();
    expect(slot().dataset.freshness).toBe('unknown');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('fresh values are normal and get a fresh dot', () => {
    renderMetric(['a:fresh']);
    expect(slot().dataset.freshness).toBe('fresh');
    expect(screen.queryByText(/as of/)).toBeNull();
    expect(screen.getByText('$622.78').parentElement?.className).not.toContain('text-muted');
  });

  it('the worst state wins across sources', () => {
    renderMetric(['a:fresh', 'a:aging', 'a:error']);
    expect(slot().dataset.freshness).toBe('error');
  });

  it('stale values are muted and labelled "as of HH:MM" (UTC pref)', () => {
    renderMetric(['a:fresh', 'a:stale']);
    expect(slot().dataset.freshness).toBe('stale');
    expect(screen.getByText('as of 14:02')).toBeTruthy();
    expect(screen.getByText('$622.78').parentElement?.className).toContain('text-muted');
  });

  it('uses the oldest degraded source for "as of"', () => {
    renderMetric(['a:stale', 'a:error']);
    expect(screen.getByText('as of 13:50')).toBeTruthy();
  });

  it('can hide the inline "as of" label', () => {
    render(
      <FreshnessProvider sources={SOURCES}>
        <Metric value="x" sources={['a:stale']} asOf={false} />
      </FreshnessProvider>,
    );
    expect(screen.queryByText(/as of/)).toBeNull();
  });

  it('marks everything stale as of the last fetch while the dashboard is offline', () => {
    renderMetric(['a:fresh'], { offline: { since: Date.UTC(2026, 8, 28, 14, 30, 0) } });
    expect(slot().dataset.freshness).toBe('stale');
    expect(screen.getByText('as of 14:30')).toBeTruthy();
  });

  it('disabled sources show a grey dot without muting', () => {
    renderMetric(['a:off']);
    expect(slot().dataset.freshness).toBe('disabled');
    expect(screen.queryByText(/as of/)).toBeNull();
  });

  it('nested providers add to, and override, their parent', () => {
    render(
      <FreshnessProvider sources={[src('k', 'fresh')]}>
        <FreshnessProvider sources={[src('k', 'error', { lastOkAt: NOW - 3_600_000 })]}>
          <Metric value="x" sources={['k']} />
        </FreshnessProvider>
      </FreshnessProvider>,
    );
    expect(slot().dataset.freshness).toBe('error');
  });

  it('opens a popover listing each source on click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderMetric(['a:fresh', 'a:error']);
    await user.click(screen.getByRole('button', { name: /Data freshness/ }));
    expect(await screen.findByText('Data freshness')).toBeTruthy();
    expect(screen.getByText('Label a:fresh')).toBeTruthy();
    expect(screen.getByText('EAPI:Invalid nonce')).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
  });
});
