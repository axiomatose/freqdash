import { describe, expect, it } from 'vitest';
import { alertCount, isActive, isMoreActive, pageTitle } from './nav';

describe('isActive', () => {
  it('matches the root only exactly', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/trades', '/')).toBe(false);
  });

  it('matches sub-paths on a segment boundary', () => {
    expect(isActive('/trades', '/trades')).toBe(true);
    expect(isActive('/trades/123', '/trades')).toBe(true);
    expect(isActive('/tradesx', '/trades')).toBe(false);
    expect(isActive('/bots/dca', '/bots/dca')).toBe(true);
    expect(isActive('/bots/dca2', '/bots/dca')).toBe(false);
  });
});

describe('isMoreActive', () => {
  it('lights the More tab for status and bot pages only', () => {
    expect(isMoreActive('/status')).toBe(true);
    expect(isMoreActive('/bots/votemax')).toBe(true);
    expect(isMoreActive('/findings')).toBe(false);
    expect(isMoreActive('/')).toBe(false);
  });
});

describe('pageTitle', () => {
  it('names the main pages', () => {
    expect(pageTitle('/')).toBe('Overview');
    expect(pageTitle('/chart')).toBe('Chart');
    expect(pageTitle('/findings')).toBe('Findings');
    expect(pageTitle('/status')).toBe('Status');
    expect(pageTitle('/nowhere')).toBe('freqdash');
  });

  it('uses the bot display name, falling back to the id', () => {
    expect(pageTitle('/bots/votemax', (id) => (id === 'votemax' ? 'VoteMax' : undefined))).toBe('VoteMax');
    expect(pageTitle('/bots/other', () => undefined)).toBe('other');
    expect(pageTitle('/bots/my%20bot')).toBe('my bot');
  });
});

describe('alertCount', () => {
  it('counts critical + warning, never info', () => {
    expect(alertCount({ critical: 2, warning: 3 })).toBe(5);
    expect(alertCount(null)).toBe(0);
    expect(alertCount(undefined)).toBe(0);
  });
});
