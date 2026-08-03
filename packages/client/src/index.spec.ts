import { describe, expect, it } from 'vitest';
import * as api from './index';

/**
 * The published surface, as a list.
 *
 * A consumer's `import { … } from '@imaginary-maths/nachbarin-client'` can only reach what is named
 * here, so this is what is actually promised. Spelled out rather than snapshotted, so that adding an
 * export is a visible edit to a list of promises.
 */
describe('public surface', () => {
  it('exports both factories and the three error classes', () => {
    expect(typeof api.createWriteClient).toBe('function');
    expect(typeof api.createReadClient).toBe('function');
    expect(typeof api.ApiError).toBe('function');
    expect(typeof api.TransportError).toBe('function');
    expect(typeof api.ValidationError).toBe('function');
  });

  it('exports the content fingerprinting helper', () => {
    expect(typeof api.contentVersionOf).toBe('function');
  });

  it('exports the limits a caller codes against', () => {
    expect(api.MAX_RECORDS_PER_BATCH).toBe(100);
    expect(api.MAX_APP_DATA_BYTES).toBe(65536);
    expect(api.MAX_REQUEST_BODY_BYTES).toBe(8 * 1024 * 1024);
    expect(api.MAX_VERSION_LENGTH).toBe(256);
    expect(api.READ_LIMIT_DEFAULT).toBe(100);
    expect(api.READ_LIMIT_MAX).toBe(1000);
  });

  it('exports nothing else', () => {
    // The `*_KEYS` arrays in protocol.ts are for the parity specs. Naming them here would keep them
    // in every consumer's bundle for nothing, so their absence is the assertion.
    expect(Object.keys(api).sort()).toEqual([
      'ApiError',
      'MAX_APP_DATA_BYTES',
      'MAX_RECORDS_PER_BATCH',
      'MAX_REQUEST_BODY_BYTES',
      'MAX_VERSION_LENGTH',
      'READ_LIMIT_DEFAULT',
      'READ_LIMIT_MAX',
      'TransportError',
      'ValidationError',
      'contentVersionOf',
      'createReadClient',
      'createWriteClient',
    ]);
  });

  it('has no createClient — a key is either read or write, never both', () => {
    expect(api).not.toHaveProperty('createClient');
  });
});
