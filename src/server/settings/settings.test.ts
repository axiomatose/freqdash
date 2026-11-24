import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../db/client';
import { getSettingRow } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { resetConfigForTests } from '../config';
import { decryptSecret, encryptSecret } from './crypto';
import { getSetting, SettingsError, settingsView, updateSettings } from './index';

const SECRET = 'session-secret-that-is-long-enough-0123456789';
let temp: TempDb;
const saved = { ...process.env };

beforeEach(() => {
  temp = installTempDb();
  Object.assign(process.env, {
    DASHBOARD_PASSWORD: 'correct-horse-battery',
    SESSION_SECRET: SECRET,
    FT_BOT_1_ID: 'votemax',
    FT_BOT_1_URL: 'http://localhost:9/x',
    FT_BOT_1_USERNAME: 'u',
    FT_BOT_1_PASSWORD: 'password-value-1',
  });
  resetConfigForTests();
});
afterEach(() => {
  temp.cleanup();
  closeDb();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetConfigForTests();
});

describe('secret encryption', () => {
  it('round-trips, uses a fresh nonce, and does not decrypt under another secret', () => {
    const a = encryptSecret('sk-test-key-123456', SECRET);
    const b = encryptSecret('sk-test-key-123456', SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-test');
    expect(decryptSecret(a, SECRET)).toBe('sk-test-key-123456');
    expect(decryptSecret(a, 'another-session-secret-0123456789abcdef')).toBeNull();
  });

  it('rejects tampered or malformed values', () => {
    const a = encryptSecret('sk-test-key-123456', SECRET);
    const parts = a.split(':');
    expect(decryptSecret([parts[0], parts[1], parts[2], 'AAAA'].join(':'), SECRET)).toBeNull();
    expect(decryptSecret('garbage', SECRET)).toBeNull();
    expect(decryptSecret('', SECRET)).toBeNull();
  });
});

describe('settings', () => {
  it('returns defaults until something is stored', () => {
    expect(getSetting('agent.enabled')).toBe(false);
    expect(getSetting('agent.baseUrl')).toBe('https://api.openai.com/v1');
    expect(getSetting('agent.apiKey')).toBeNull();
    expect(getSetting('agent.maxSteps')).toBe(8);
  });

  it('stores values, encrypts secrets at rest and never reveals them in the view', () => {
    updateSettings(
      { 'agent.enabled': true, 'agent.model': 'gpt-4.1-mini', 'agent.apiKey': 'sk-live-abcdef123456' },
      'Ada',
      1000,
    );
    expect(getSetting('agent.enabled')).toBe(true);
    expect(getSetting('agent.model')).toBe('gpt-4.1-mini');
    expect(getSetting('agent.apiKey')).toBe('sk-live-abcdef123456');
    const row = getSettingRow('agent.apiKey');
    expect(row?.secret).toBe(true);
    expect(row?.value).not.toContain('sk-live');
    const view = settingsView();
    expect(JSON.stringify(view)).not.toContain('sk-live');
    expect(view.secretsSet['agent.apiKey']).toBe(true);
    expect(view.values['agent.model']).toBe('gpt-4.1-mini');
    expect(view.updatedAt).toBe(1000);
    expect(getSettingRow('agent.model')?.updatedBy).toBe('Ada');
  });

  it('null clears a setting back to its default', () => {
    updateSettings({ 'agent.model': 'x-model', 'agent.apiKey': 'sk-live-abcdef123456' }, null, 1);
    updateSettings({ 'agent.model': null, 'agent.apiKey': null }, null, 2);
    expect(getSetting('agent.model')).toBeNull();
    expect(settingsView().values['agent.model']).toBe('');
    expect(getSetting('agent.apiKey')).toBeNull();
    expect(settingsView().secretsSet['agent.apiKey']).toBe(false);
  });

  it('validates everything before writing anything', () => {
    expect(() => updateSettings({ 'agent.enabled': true, 'agent.baseUrl': 'ftp://x' }, null, 1)).toThrow(SettingsError);
    expect(getSetting('agent.enabled')).toBe(false);
    expect(() => updateSettings({ 'agent.baseUrl': 'https://user:pw@example.com/v1' }, null, 1)).toThrow(/credentials/);
    expect(() => updateSettings({ 'agent.maxSteps': 50 }, null, 1)).toThrow();
    expect(() => updateSettings({ 'agent.apiKey': 'short' }, null, 1)).toThrow();
    expect(() => updateSettings({ 'agent.enabled': 'yes' }, null, 1)).toThrow();
  });

  it('a secret stored under another SESSION_SECRET reads as not set', () => {
    updateSettings({ 'agent.apiKey': 'sk-live-abcdef123456' }, null, 1);
    process.env.SESSION_SECRET = 'a-different-session-secret-0123456789abc';
    resetConfigForTests();
    expect(getSetting('agent.apiKey')).toBeNull();
    expect(settingsView().secretsSet['agent.apiKey']).toBe(false);
  });
});
