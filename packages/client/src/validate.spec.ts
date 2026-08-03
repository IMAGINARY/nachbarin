import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import { MAX_APP_DATA_BYTES } from './protocol';
import { buildWireRecord, validateCreatedAt } from './validate';
import { FIXED_CREATED_AT, testUuid } from './test-support';

function draft(overrides: Record<string, unknown> = {}) {
  return {
    clientId: testUuid(),
    createdAt: FIXED_CREATED_AT,
    engineVersion: 'engine-1.4.2',
    appData: { choice: 'bus' },
    ...overrides,
  };
}

describe('app_data', () => {
  it('measures bytes rather than characters', () => {
    // '€' is one character and three bytes. The serialized form adds two quotes, so 21844 of them is
    // 65534 bytes and one more is 65537 — while `.length` is nowhere near the limit either way. A
    // check written against `.length` accepts all of these, and the service rejects every one.
    const fits = '€'.repeat(21844);
    const over = '€'.repeat(21845);

    expect(over.length).toBeLessThan(MAX_APP_DATA_BYTES);
    expect(buildWireRecord(draft({ appData: fits })).bytes).toBeGreaterThan(fits.length);
    expect(() => buildWireRecord(draft({ appData: over }))).toThrow(ValidationError);
  });

  it('accepts exactly the limit and refuses one byte more', () => {
    // The serialized form is `"aaa…"`, so the payload is two bytes of quotes plus the content.
    const atLimit = 'a'.repeat(MAX_APP_DATA_BYTES - 2);
    expect(() => buildWireRecord(draft({ appData: atLimit }))).not.toThrow();
    expect(() => buildWireRecord(draft({ appData: `${atLimit}a` }))).toThrow(/is 65537 bytes/);
  });

  it('accepts any JSON value, null included', () => {
    for (const appData of [null, 0, false, '', [], {}, [1, { a: null }]]) {
      expect(() => buildWireRecord(draft({ appData }))).not.toThrow();
    }
  });

  it('refuses values JSON cannot express', () => {
    expect(() => buildWireRecord(draft({ appData: undefined }))).toThrow(/must be a JSON value/);
    expect(() => buildWireRecord(draft({ appData: () => 1 }))).toThrow(/must be a JSON value/);
    expect(() => buildWireRecord(draft({ appData: Symbol('x') }))).toThrow(/must be a JSON value/);
  });

  it('refuses a NUL inside a string', () => {
    expect(() => buildWireRecord(draft({ appData: { note: `a${String.fromCharCode(0)}b` } }))).toThrow(/NUL/);
  });

  it('detaches the payload, so mutating it afterwards changes nothing', () => {
    const appData: { choice: string } = { choice: 'bus' };
    const built = buildWireRecord(draft({ appData }));
    appData.choice = 'tram';

    expect(built.wire.app_data).toEqual({ choice: 'bus' });
  });

  it('names the field the way the wire does', () => {
    try {
      buildWireRecord(draft({ appData: undefined }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('app_data');
    }
  });
});

describe('client_id', () => {
  it('normalizes to lowercase', () => {
    const built = buildWireRecord(draft({ clientId: '3F8A1C2E-7B40-4D6A-9E11-0C5F8A2B3D41' }));
    expect(built.wire.client_id).toBe('3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41');
  });

  it('refuses the nil UUID', () => {
    expect(() => buildWireRecord(draft({ clientId: '00000000-0000-0000-0000-000000000000' }))).toThrow(/nil UUID/);
  });

  it('refuses anything that is not a UUID', () => {
    for (const clientId of ['', 'not-a-uuid', '3f8a1c2e7b404d6a9e110c5f8a2b3d41']) {
      expect(() => buildWireRecord(draft({ clientId }))).toThrow(/must be a UUID/);
    }
  });

  it('accepts any UUID version', () => {
    // v7 is time-ordered and a sensible choice; refusing it would be refusing a better id.
    expect(() => buildWireRecord(draft({ clientId: '01912d68-783e-7000-8000-1a2b3c4d5e6f' }))).not.toThrow();
  });
});

describe('created_at', () => {
  it('rolls nothing over — the Date.parse trap', () => {
    // Date.parse('2026-02-30T…') is not NaN; it is March 2nd. Silently storing a record two days
    // from where the exhibit said it happened is worse than refusing it.
    expect(() => validateCreatedAt('2026-02-30T00:00:00Z')).toThrow(/invalid day of month/);
    expect(() => validateCreatedAt('2025-02-29T00:00:00Z')).toThrow(/invalid day of month/);
    expect(() => validateCreatedAt('2024-02-29T00:00:00Z')).not.toThrow();
    expect(() => validateCreatedAt('2026-04-31T00:00:00Z')).toThrow(/invalid day of month/);
  });

  it('range-checks every component', () => {
    expect(() => validateCreatedAt('2026-13-01T00:00:00Z')).toThrow(/invalid month/);
    expect(() => validateCreatedAt('2026-07-15T24:00:00Z')).toThrow(/invalid hour/);
    expect(() => validateCreatedAt('2026-07-15T00:60:00Z')).toThrow(/invalid minute/);
    // A leap second is legal RFC 3339 and nothing downstream can represent one.
    expect(() => validateCreatedAt('2026-07-15T23:59:60Z')).toThrow(/invalid second/);
    expect(() => validateCreatedAt('2026-07-15T00:00:00+24:00')).toThrow(/invalid UTC offset/);
  });

  it('requires an explicit offset', () => {
    expect(() => validateCreatedAt('2026-07-15T14:03:22')).toThrow(/RFC 3339/);
    expect(() => validateCreatedAt('2026-07-15')).toThrow(/RFC 3339/);
  });

  it('accepts lowercase t and z, and fractional seconds', () => {
    expect(validateCreatedAt('2026-07-15t14:03:22z')).toBe('2026-07-15t14:03:22z');
    expect(validateCreatedAt('2026-07-15T14:03:22.123456789+05:45')).toBe('2026-07-15T14:03:22.123456789+05:45');
  });

  it('returns the string verbatim, offset and all', () => {
    // The offset carries the exhibit's local frame, and the service slices the date off the front of
    // this exact string. Normalizing to UTC here would move that date for half the planet.
    expect(buildWireRecord(draft({ createdAt: '2026-07-15T00:30:00+02:00' })).wire.created_at).toBe('2026-07-15T00:30:00+02:00');
  });

  it('accepts a clock that is obviously wrong', () => {
    // A dead RTC reporting 1970 is a record, not an error. Skew stays visible via received_date.
    expect(() => validateCreatedAt('1970-01-01T04:00:00+01:00')).not.toThrow();
  });
});

describe('versions', () => {
  it('bounds engine_version', () => {
    expect(() => buildWireRecord(draft({ engineVersion: '' }))).toThrow(/must not be empty/);
    expect(() => buildWireRecord(draft({ engineVersion: 'a'.repeat(257) }))).toThrow(/at most 256/);
    expect(() => buildWireRecord(draft({ engineVersion: 'a'.repeat(256) }))).not.toThrow();
  });

  it('omits content_version rather than sending null', () => {
    const built = buildWireRecord(draft());
    expect('content_version' in built.wire).toBe(false);
    expect(JSON.parse(JSON.stringify(built.wire))).not.toHaveProperty('content_version');
  });

  it('refuses an explicit null content_version', () => {
    // Absent and null are different to the service and only absent is spellable, so swapping one for
    // the other silently would hide the caller's misunderstanding until the service rejected it.
    expect(() => buildWireRecord(draft({ contentVersion: null }))).toThrow(/omitted rather than null/);
  });

  it('carries a content_version that was given', () => {
    expect(buildWireRecord(draft({ contentVersion: 'sha256:ab12' })).wire.content_version).toBe('sha256:ab12');
  });
});
