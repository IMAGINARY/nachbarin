import { describe, expect, it } from 'vitest';
import { validateReadQuery, validateRecord, validateWriteEnvelope } from '../src/validation';
import { recordWithout, validRecord } from './fakes';

/** Unwraps a successful result, failing loudly with the error if it wasn't one. */
function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function expectFail(result: { ok: true } | { ok: false; error: { code: string; message: string } }) {
  if (result.ok) throw new Error('expected failure, got ok');
  return result.error;
}

describe('created_at', () => {
  const withDate = (created_at: unknown) => validateRecord(validRecord({ created_at }));

  it('accepts offsets, both cases of the T/Z separators, and fractional seconds', () => {
    const accepted = [
      '2026-07-15T14:03:22Z',
      '2026-07-15T14:03:22+02:00',
      '2026-07-15T14:03:22-05:00',
      '2026-07-15T14:03:22-00:00', // RFC 3339: "offset unknown"
      '2026-07-15t14:03:22z',
      '2026-07-15T14:03:22.123456Z',
    ];
    for (const created_at of accepted) {
      expect(expectOk(withDate(created_at)).createdAt).toBe(created_at);
    }
  });

  // Regression: Date.parse('2026-02-30T00:00:00Z') returns 2026-03-02, NOT NaN. A regex plus
  // Date.parse would accept this and silently shift the record two days.
  it('rejects a day past the end of the month rather than rolling it over', () => {
    expect(expectFail(withDate('2026-02-30T00:00:00Z')).code).toBe('invalid_field');
    expect(expectFail(withDate('2026-04-31T00:00:00Z')).code).toBe('invalid_field');
  });

  // Same trap: Date.parse('2025-02-29T00:00:00Z') returns 2025-03-01.
  it('handles leap years', () => {
    expect(expectFail(withDate('2025-02-29T00:00:00Z')).code).toBe('invalid_field');
    expect(expectOk(withDate('2024-02-29T00:00:00Z')).createdAt).toBe('2024-02-29T00:00:00Z');
    expect(expectOk(withDate('2026-02-28T00:00:00Z')).createdAt).toBe('2026-02-28T00:00:00Z');
  });

  it('rejects malformed timestamps', () => {
    const rejected = [
      '2026-07-15T14:03:22', // no offset
      '2026-13-01T00:00:00Z', // month 13
      '2026-00-01T00:00:00Z', // month 0
      '2026-07-00T00:00:00Z', // day 0
      '2026-07-15T25:00:00Z', // hour 25
      '2026-07-15T14:60:00Z', // minute 60
      '2026-07-15T23:59:60Z', // leap second
      '2026-07-15T14:03:22+24:00', // offset hour 24
      '2026-07-15 14:03:22Z', // space separator
      '2026-07-15', // date only
      '',
    ];
    for (const created_at of rejected) {
      expect(expectFail(withDate(created_at)).code, created_at).toBe('invalid_field');
    }
  });

  it('rejects non-strings and absence', () => {
    expect(expectFail(withDate(1752588202)).code).toBe('invalid_field');
    expect(expectFail(withDate(null)).code).toBe('invalid_field');
    const rest = recordWithout('created_at');
    expect(expectFail(validateRecord(rest)).message).toContain('created_at is required');
  });

  // created_date and received_date are stored side by side precisely so skew stays visible.
  // Rejecting it at the door would destroy the evidence.
  it('accepts implausible clocks, because skew is meant to be detectable rather than refused', () => {
    expect(expectOk(withDate('1970-01-01T00:00:00Z')).createdAt).toBe('1970-01-01T00:00:00Z');
    expect(expectOk(withDate('2099-12-31T23:59:59Z')).createdAt).toBe('2099-12-31T23:59:59Z');
  });

  it('preserves the offset verbatim instead of normalizing to UTC', () => {
    expect(expectOk(withDate('2026-07-15T14:03:22+02:00')).createdAt).toBe('2026-07-15T14:03:22+02:00');
  });
});

describe('client_id', () => {
  const withId = (client_id: unknown) => validateRecord(validRecord({ client_id }));

  it('accepts any UUID version', () => {
    expect(expectOk(withId('3f8a1b2c-0000-4000-8000-000000000001')).clientId).toBeTruthy(); // v4
    expect(expectOk(withId('01920000-0000-7000-8000-000000000001')).clientId).toBeTruthy(); // v7
  });

  it('normalizes to lowercase, so dedupe does not depend on the backend collation', () => {
    expect(expectOk(withId('3F8A1B2C-0000-4000-8000-00000000000A')).clientId).toBe(
      '3f8a1b2c-0000-4000-8000-00000000000a',
    );
  });

  // The nil UUID is what an uninitialized variable looks like. Since duplicate counts as success,
  // a client sending it for every record would have every record acknowledged and dropped after
  // the first — silent, total data loss that looks healthy from the outside.
  it('rejects the nil UUID', () => {
    expect(expectFail(withId('00000000-0000-0000-0000-000000000000')).message).toContain('nil UUID');
  });

  it('rejects non-UUIDs and non-strings', () => {
    for (const value of ['not-a-uuid', '', '3f8a1b2c-0000-4000-8000', 123, null, {}]) {
      expect(expectFail(withId(value)).code).toBe('invalid_field');
    }
  });
});

describe('app_data', () => {
  const withData = (app_data: unknown) => validateRecord(validRecord({ app_data }));

  // "Never interpreted" is load-bearing: any type restriction would be an interpretation.
  it('accepts any JSON value, including null and scalars', () => {
    expect(expectOk(withData({ a: 1 })).appDataJson).toBe('{"a":1}');
    expect(expectOk(withData([1, 2])).appDataJson).toBe('[1,2]');
    expect(expectOk(withData('text')).appDataJson).toBe('"text"');
    expect(expectOk(withData(42)).appDataJson).toBe('42');
    expect(expectOk(withData(true)).appDataJson).toBe('true');
    expect(expectOk(withData(null)).appDataJson).toBe('null');
  });

  it('requires the key to be present, which is distinct from a JSON null', () => {
    const rest = recordWithout('app_data');
    expect(expectFail(validateRecord(rest)).message).toContain('app_data is required');
  });

  it('enforces the size limit at the boundary', () => {
    expect(withData({ a: 'x'.repeat(64 * 1024 - 10) }).ok).toBe(true);
    expect(expectFail(withData({ a: 'x'.repeat(64 * 1024) })).code).toBe('payload_too_large');
  });

  it('measures bytes rather than code units', () => {
    // 30k emoji is 30k UTF-16 surrogate pairs but 120k UTF-8 bytes.
    const emoji = '🎨'.repeat(30_000);
    expect(emoji.length).toBeLessThan(64 * 1024);
    expect(expectFail(withData(emoji)).code).toBe('payload_too_large');
  });

  it('measures the compact serialization, so client formatting cannot affect the verdict', () => {
    const value = { nodes: [['q1', 3]] };
    const compact = expectOk(withData(value)).appDataJson;
    // The same value parsed from pretty-printed JSON must measure identically.
    const pretty: unknown = JSON.parse(JSON.stringify(value, null, 4));
    expect(expectOk(withData(pretty)).appDataJson).toBe(compact);
    expect(compact).not.toContain('\n');
  });

  it('rejects NUL, which jsonb cannot store', () => {
    expect(expectFail(withData({ a: 'x\u0000y' })).message).toContain('NUL');
  });
});

describe('version fields', () => {
  it('requires engine_version', () => {
    const rest = recordWithout('engine_version');
    expect(expectFail(validateRecord(rest)).message).toContain('engine_version is required');
    expect(expectFail(validateRecord(validRecord({ engine_version: '' }))).code).toBe('invalid_field');
    expect(expectFail(validateRecord(validRecord({ engine_version: 42 }))).code).toBe('invalid_field');
  });

  // Optional so an app with no notion of content version need not invent a placeholder.
  it('defaults an absent content_version to null rather than an empty string', () => {
    expect(expectOk(validateRecord(validRecord())).contentVersion).toBeNull();
    expect(expectOk(validateRecord(validRecord({ content_version: 'sha256:ab12' }))).contentVersion).toBe(
      'sha256:ab12',
    );
  });

  it('rejects an explicitly empty or over-long content_version', () => {
    expect(expectFail(validateRecord(validRecord({ content_version: '' }))).code).toBe('invalid_field');
    expect(expectFail(validateRecord(validRecord({ content_version: 'x'.repeat(257) }))).code).toBe('invalid_field');
    expect(validateRecord(validRecord({ content_version: 'x'.repeat(256) })).ok).toBe(true);
  });
});

describe('unknown fields', () => {
  it('rejects unknown record keys, so a typo cannot silently become a null column', () => {
    expect(expectFail(validateRecord(validRecord({ content_ver: 'oops' }))).message).toContain('content_ver');
  });

  it('rejects unknown envelope keys', () => {
    expect(expectFail(validateWriteEnvelope({ records: [], extra: 1 })).message).toContain('extra');
  });

  // Identity comes from the key alone; a body claiming otherwise is a client bug worth surfacing.
  it('rejects a body-supplied instance_id', () => {
    expect(expectFail(validateRecord(validRecord({ instance_id: 'spoofed' }))).message).toContain('instance_id');
  });
});

describe('write envelope', () => {
  it('accepts an empty batch', () => {
    expect(expectOk(validateWriteEnvelope({ records: [] }))).toEqual([]);
  });

  it('rejects a non-object root or a non-array records', () => {
    expect(expectFail(validateWriteEnvelope([])).code).toBe('invalid_request');
    expect(expectFail(validateWriteEnvelope('x')).code).toBe('invalid_request');
    expect(expectFail(validateWriteEnvelope(null)).code).toBe('invalid_request');
    expect(expectFail(validateWriteEnvelope({ records: {} })).code).toBe('invalid_request');
    expect(expectFail(validateWriteEnvelope({})).message).toContain('records is required');
  });

  it('rejects an over-long batch whole rather than per record', () => {
    const records = Array.from({ length: 101 }, () => validRecord());
    expect(expectFail(validateWriteEnvelope({ records })).code).toBe('batch_too_large');
    expect(validateWriteEnvelope({ records: records.slice(0, 100) }).ok).toBe(true);
  });
});

describe('read query', () => {
  const query = (search: string) => validateReadQuery(new URLSearchParams(search));

  it('defaults after_id to 0 and limit to 100', () => {
    expect(expectOk(query(''))).toMatchObject({ afterId: 0, limit: 100 });
  });

  it('parses paging and filters', () => {
    expect(expectOk(query('after_id=184002&limit=1000&engine_version=v1&content_version=c1'))).toEqual({
      afterId: 184002,
      limit: 1000,
      engineVersion: 'v1',
      contentVersion: 'c1',
    });
  });

  // Regression: parseInt('1e5') is 1 and parseInt('184002abc') is 184002. Quietly reinterpreting a
  // cursor is the worst available failure, so these must be loud.
  it('rejects after_id values that parseInt would silently truncate', () => {
    expect(expectFail(query('after_id=1e5')).code).toBe('invalid_request');
    expect(expectFail(query('after_id=184002abc')).code).toBe('invalid_request');
    expect(expectFail(query('after_id=-1')).code).toBe('invalid_request');
    expect(expectFail(query('after_id=1.5')).code).toBe('invalid_request');
    expect(expectFail(query('after_id= 5')).code).toBe('invalid_request');
    expect(expectFail(query('after_id=')).code).toBe('invalid_request');
  });

  it('rejects an after_id beyond exact integer precision', () => {
    expect(expectFail(query(`after_id=${String(Number.MAX_SAFE_INTEGER + 2)}`)).code).toBe('invalid_request');
    expect(query(`after_id=${String(Number.MAX_SAFE_INTEGER)}`).ok).toBe(true);
  });

  // limit=0 would return nothing with has_more true forever: a poll loop that never advances.
  it('rejects limit outside 1..1000', () => {
    expect(expectFail(query('limit=0')).code).toBe('invalid_request');
    expect(expectFail(query('limit=1001')).code).toBe('invalid_request');
    expect(query('limit=1').ok).toBe(true);
  });

  // ?after= would leave the cursor at 0 and silently re-download the entire corpus.
  it('rejects unknown parameters and names them', () => {
    const error = expectFail(query('after=184002'));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('after');
  });

  // URLSearchParams.get returns the first and discards the rest.
  it('rejects repeated parameters', () => {
    expect(expectFail(query('limit=10&limit=20')).message).toContain('limit');
  });

  // The boundary is pinned at a literal 256 rather than read from MAX_VERSION_LENGTH: a test that
  // imports the constant would happily follow it wherever someone moved it, and this is a limit
  // client authors code against.
  it('rejects empty and over-long filter values', () => {
    expect(expectFail(query('engine_version=')).code).toBe('invalid_request');
    expect(query(`content_version=${'x'.repeat(256)}`).ok).toBe(true);
    expect(expectFail(query(`content_version=${'x'.repeat(257)}`)).code).toBe('invalid_request');
  });

  // A read's scope is settled by the key. These once selected an installation; leaving them
  // accepted-and-ignored would mean an operator asking for one museum and silently being handed
  // another's, so they must be as unknown as any other typo.
  it('rejects app and instance as unknown parameters', () => {
    expect(expectFail(query('app=a1')).message).toContain('app');
    expect(expectFail(query('instance=i1')).message).toContain('instance');
  });
});
