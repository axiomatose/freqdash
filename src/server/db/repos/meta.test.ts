import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTempDb, type TempDb } from '../testing';
import { getMeta, getMetaNumber, setMeta } from './meta';
import { LATEST_SCHEMA_VERSION } from '../migrations';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

describe('meta', () => {
  it('returns null for a missing key and the schema version for the built-in key', () => {
    expect(getMeta('nope')).toBeNull();
    expect(getMeta('schema_version')).toBe(String(LATEST_SCHEMA_VERSION));
  });

  it('stores and overwrites values', () => {
    setMeta('recon_start_at', '1790000000000');
    expect(getMeta('recon_start_at')).toBe('1790000000000');
    setMeta('recon_start_at', '5');
    expect(getMeta('recon_start_at')).toBe('5');
  });

  it('stores numbers as text and reads them back as numbers', () => {
    setMeta('kraken_nonce', 1790568007965123);
    expect(getMeta('kraken_nonce')).toBe('1790568007965123');
    expect(getMetaNumber('kraken_nonce')).toBe(1790568007965123);
  });

  it('getMetaNumber is null for missing, blank or non-numeric values', () => {
    expect(getMetaNumber('missing')).toBeNull();
    setMeta('blank', '  ');
    setMeta('text', 'abc');
    expect(getMetaNumber('blank')).toBeNull();
    expect(getMetaNumber('text')).toBeNull();
  });
});
