import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectIdSource, formatRfc3339, newCreatedAt, newUuid } from './mint';
import { validateClientId, validateCreatedAt } from './validate';

/** Replaces `globalThis.crypto` for one test. `undefined` deletes it, as a runtime below the floor can. */
function stubCrypto(value: unknown): void {
  vi.stubGlobal('crypto', value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('formatRfc3339', () => {
  const noon = Date.UTC(2026, 6, 15, 12, 0, 0);

  it('negates getTimezoneOffset, because that is the direction it runs', () => {
    // getTimezoneOffset() returns minutes to ADD TO LOCAL to get UTC, so UTC+02:00 is -120. Getting
    // this backwards produces a timestamp that is valid, plausible, and wrong by twice the offset.
    expect(formatRfc3339(noon, -120)).toBe('2026-07-15T14:00:00+02:00');
    expect(formatRfc3339(noon, 300)).toBe('2026-07-15T07:00:00-05:00');
  });

  it('handles offsets that are not whole hours', () => {
    expect(formatRfc3339(noon, -330)).toBe('2026-07-15T17:30:00+05:30'); // India
    expect(formatRfc3339(noon, -345)).toBe('2026-07-15T17:45:00+05:45'); // Nepal
    expect(formatRfc3339(noon, -765)).toBe('2026-07-16T00:45:00+12:45'); // Chatham
  });

  it('spells UTC as +00:00 rather than Z', () => {
    expect(formatRfc3339(noon, 0)).toBe('2026-07-15T12:00:00+00:00');
  });

  it('pads a year that a failing clock could produce', () => {
    expect(formatRfc3339(Date.UTC(999, 0, 2), 0)).toBe('0999-01-02T00:00:00+00:00');
  });

  it('clamps a clock outside what RFC 3339 can spell, rather than emitting an invalid string', () => {
    // A record with a nonsense date is stored and visibly wrong; a record the service refuses is
    // lost. `received_date` is what makes the first one legible.
    expect(() => validateCreatedAt(formatRfc3339(-1e15, 0))).not.toThrow();
    expect(() => validateCreatedAt(formatRfc3339(1e15, 0))).not.toThrow();
    expect(formatRfc3339(-1e15, 0)).toBe('0001-01-01T00:00:00+00:00');
    expect(formatRfc3339(1e15, 0)).toBe('9999-12-31T23:59:59+00:00');
  });

  it('survives a non-finite clock', () => {
    expect(() => validateCreatedAt(formatRfc3339(Number.NaN, 0))).not.toThrow();
    expect(() => validateCreatedAt(formatRfc3339(noon, Number.NaN))).not.toThrow();
  });

  it('always produces something the service accepts', () => {
    for (const offset of [-765, -330, -120, 0, 60, 300, 720]) {
      expect(() => validateCreatedAt(formatRfc3339(noon, offset))).not.toThrow();
    }
  });
});

describe('newCreatedAt', () => {
  it('reads the clock once, so a DST boundary cannot mismatch the offset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));

    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset');
    const value = newCreatedAt();

    expect(() => validateCreatedAt(value)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('newUuid', () => {
  it('uses randomUUID when the runtime has it', () => {
    const randomUUID = vi.fn(() => '3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41');
    stubCrypto({ randomUUID });

    expect(detectIdSource()).toBe('crypto.randomUUID');
    expect(newUuid()).toBe('3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('falls back to getRandomValues — the insecure-context kiosk', () => {
    // A kiosk served from http://192.168.1.50 has `crypto` but not `randomUUID`, which is
    // secure-context only. getRandomValues has no such gate.
    const getRandomValues = vi.fn((array: Uint8Array) => {
      array.fill(0xab);
      return array;
    });
    stubCrypto({ getRandomValues });

    expect(detectIdSource()).toBe('crypto.getRandomValues');
    const id = newUuid();
    expect(getRandomValues).toHaveBeenCalledOnce();
    // 0xab & 0x0f | 0x40 = 0x4b in the version position; 0xab & 0x3f | 0x80 is 0xab again.
    expect(id).toBe('abababab-abab-4bab-abab-abababababab');
    expect(() => validateClientId(id)).not.toThrow();
  });

  it('falls back to Math.random when there is no global crypto at all', () => {
    stubCrypto(undefined);

    expect(detectIdSource()).toBe('Math.random');
    expect(() => validateClientId(newUuid())).not.toThrow();
  });

  it('falls through a crypto that exists but throws', () => {
    stubCrypto({
      randomUUID: () => {
        throw new Error('nope');
      },
      getRandomValues: () => {
        throw new Error('also nope');
      },
    });

    expect(() => validateClientId(newUuid())).not.toThrow();
  });

  it('never throws, on any rung', () => {
    // The alternative is a kiosk whose game cannot start, unattended, because of a missing CSPRNG —
    // which loses every visitor's record rather than one.
    for (const value of [undefined, null, {}, { randomUUID: null }, 'nonsense']) {
      stubCrypto(value);
      expect(() => newUuid()).not.toThrow();
      expect(() => validateClientId(newUuid())).not.toThrow();
    }
  });

  it('sets the version and variant nibbles, which makes the nil UUID unreachable', () => {
    stubCrypto({
      getRandomValues: (array: Uint8Array) => {
        array.fill(0);
        return array;
      },
    });

    const id = newUuid();
    expect(id).toBe('00000000-0000-4000-8000-000000000000');
    // All sixteen bytes were zero and it still is not the nil UUID — which is the one client_id the
    // service refuses, and the one whose acceptance would look like success while losing everything.
    expect(() => validateClientId(id)).not.toThrow();
  });

  it('produces distinct ids', () => {
    stubCrypto(undefined);
    const ids = new Set(Array.from({ length: 500 }, () => newUuid()));
    expect(ids.size).toBe(500);
  });
});
