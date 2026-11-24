import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config';

const KRAKEN_SECRET = Buffer.alloc(64, 7).toString('base64');
const base = {
  SESSION_SECRET: 'session-secret-that-is-long-enough-0123456789',
  FT_BOT_1_ID: 'votemax',
  FT_BOT_1_URL: 'http://freqtrade-votemax:8080',
  FT_BOT_1_USERNAME: 'u',
  FT_BOT_1_PASSWORD: 'password-value-1',
  KRAKEN_API_KEY: 'key',
  KRAKEN_API_SECRET: KRAKEN_SECRET,
};
const TOKEN = 'k'.repeat(32);

function problems(env: Record<string, string>): string[] {
  try {
    parseConfig(env);
    return [];
  } catch (err) {
    return err instanceof ConfigError ? err.issues.map((i) => i.variable) : ['?'];
  }
}

describe('killswitch configuration', () => {
  it('is off by default with the 2-in-30-s and 3-in-10-min limits', () => {
    expect(parseConfig(base).killswitch).toMatchObject({
      mode: 'off',
      maxBuysShort: 2,
      windowShortMs: 30_000,
      maxBuysLong: 3,
      windowLongMs: 600_000,
    });
    expect(parseConfig(base).bots[0]?.container).toBeNull();
  });

  it('armed needs the agent URL, the token and at least one container', () => {
    expect(problems({ ...base, KILLSWITCH_MODE: 'armed' })).toEqual(
      expect.arrayContaining(['KILLSWITCH_AGENT_URL', 'KILLSWITCH_TOKEN', 'FT_BOT_1_CONTAINER']),
    );
    const cfg = parseConfig({
      ...base,
      KILLSWITCH_MODE: 'ARMED',
      KILLSWITCH_AGENT_URL: 'http://killswitch-agent:9100/',
      KILLSWITCH_TOKEN: TOKEN,
      FT_BOT_1_CONTAINER: 'freqtrade-votemax',
      KILLSWITCH_MAX_BUYS_30S: '4',
    });
    expect(cfg.killswitch).toMatchObject({ mode: 'armed', agentUrl: 'http://killswitch-agent:9100', maxBuysShort: 4 });
    expect(cfg.bots[0]?.container).toBe('freqtrade-votemax');
  });

  it('dry-run needs no agent, but every enabled mode needs the Kraken key', () => {
    expect(problems({ ...base, KILLSWITCH_MODE: 'dry-run' })).toEqual([]);
    const { KRAKEN_API_KEY: _k, KRAKEN_API_SECRET: _s, ...noKraken } = base;
    expect(problems({ ...noKraken, KILLSWITCH_MODE: 'dry-run' })).toContain('KRAKEN_API_KEY');
  });

  it('validates the values and never echoes the token', () => {
    expect(problems({ ...base, KILLSWITCH_MODE: 'yes' })).toContain('KILLSWITCH_MODE');
    expect(problems({ ...base, KILLSWITCH_TOKEN: 'short' })).toContain('KILLSWITCH_TOKEN');
    expect(problems({ ...base, FT_BOT_1_CONTAINER: 'bad name!' })).toContain('FT_BOT_1_CONTAINER');
    expect(problems({ ...base, KILLSWITCH_MAX_BUYS_30S: '0' })).toContain('KILLSWITCH_MAX_BUYS_30S');
    try {
      parseConfig({ ...base, KILLSWITCH_TOKEN: 'short-secret-value' });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('short-secret-value');
    }
  });
});
