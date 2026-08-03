import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentVersionOf } from './content-version';
import { buildWireRecord, validateVersion } from './validate';

/**
 * Every expected digest here is **hardcoded, not computed**. Deriving them from the code under test
 * would make each assertion a tautology — the same reason test/d1-key-store.spec.ts hardcodes its
 * key hashes. Reproduce any line from a shell:
 *
 * ```
 * printf %s "abc" | shasum -a 256
 * ```
 *
 * `echo` appends a newline and hashes something else, which is worth knowing before concluding the
 * implementation is wrong.
 *
 * Deliberately no `import { createHash } from 'node:crypto'` to compute expectations. It would be
 * the tautology above, and it would pull a Node builtin into a package whose tsconfig (`types: []`)
 * exists to keep them out — and would not even fail to compile, since that setting covers globals
 * only and @types/node is hoisted from the repo root. Review is the only guard, so: don't.
 */
const EMPTY = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const UNICODE = 'sha256:cbbcee01a3fc5f1c0db23e02be25316adf28ede876031fdbabe5f4fabe47ed7f';
const MILLION_A = 'sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contentVersionOf', () => {
  it('matches the published SHA-256 vectors', async () => {
    await expect(contentVersionOf('')).resolves.toBe(EMPTY);
    await expect(contentVersionOf('abc')).resolves.toBe(ABC);
    // The large-input case: nothing chunks, truncates or overflows a length counter.
    await expect(contentVersionOf('a'.repeat(1_000_000))).resolves.toBe(MILLION_A);
  });

  it('pads bytes below 0x10 to two hex digits', async () => {
    // Not a redundant restatement of the vector above — keep both. 'abc' is the FIPS 180-4 vector
    // *and* its digest happens to contain the bytes 00, 01 and 03, so it is also the only thing
    // standing between a missing `padStart(2, '0')` and production. Without the pad those three
    // bytes each contribute one character instead of two, and the result is a 61-character string
    // that is still non-empty, still under 256, and refused by nothing on either side of the wire.
    const value = await contentVersionOf('abc');
    expect(value).toBe(ABC);
    expect(value).toHaveLength('sha256:'.length + 64);
    expect(value).toContain('00');
  });

  it('encodes as UTF-8, not UTF-16 or latin1', async () => {
    // 'é' is two UTF-8 bytes and '🌍' is four — a surrogate pair in JS. Either mistake changes the
    // digest of every non-ASCII content file, silently and permanently.
    await expect(contentVersionOf('héllo 🌍')).resolves.toBe(UNICODE);
  });

  it('always produces the same shape', async () => {
    for (const input of ['', 'abc', 'héllo 🌍', 'a'.repeat(1_000)]) {
      await expect(contentVersionOf(input)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('accepts bytes and a string interchangeably', async () => {
    const bytes = new TextEncoder().encode('abc');
    await expect(contentVersionOf(bytes)).resolves.toBe(ABC);
  });

  it('respects a view offset rather than reaching through .buffer', async () => {
    // A future refactor to `bytes.buffer` would hash all nine bytes and still look correct.
    const padded = new TextEncoder().encode('xxxabcxxx');
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 3, 3);
    await expect(contentVersionOf(view)).resolves.toBe(ABC);
  });

  it('is deterministic, and an avalanche away from its neighbours', async () => {
    await expect(contentVersionOf('content')).resolves.toBe(await contentVersionOf('content'));
    expect(await contentVersionOf('content')).not.toBe(await contentVersionOf('contenu'));
  });

  it('produces something the service accepts', async () => {
    // The point of the helper is a value that is admissible by construction rather than by luck:
    // 71 characters against a 256 limit, non-empty, never null.
    for (const input of ['', 'abc', 'a'.repeat(1_000_000)]) {
      const value = await contentVersionOf(input);
      expect(() => validateVersion(value, 'content_version')).not.toThrow();
    }
  });

  it('survives the whole producer path onto the wire', async () => {
    const { wire } = buildWireRecord({
      clientId: '3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41',
      createdAt: '2026-07-15T14:03:22+02:00',
      engineVersion: 'future-mobility-simulator@1.4.2',
      contentVersion: await contentVersionOf('abc'),
      appData: { choice: 'bus' },
    });

    expect(wire.content_version).toBe(ABC);
  });

  describe('when crypto.subtle is missing', () => {
    // A kiosk served from http://192.168.1.50 has `crypto` and not `subtle`, which is
    // secure-context only; an old Node run without --experimental-global-webcrypto has no
    // `globalThis.crypto` at all. Both must fail loudly. A fallback to a second algorithm is the one
    // thing this function must never do — it would hash one game script to two different values
    // depending on where the page was served from, with every record looking perfectly fine.
    for (const [label, value] of [
      ['there is no crypto at all', undefined],
      ['crypto exists without subtle — the insecure-context kiosk', {}],
    ] as const) {
      it(`rejects when ${label}`, async () => {
        vi.stubGlobal('crypto', value);
        await expect(contentVersionOf('abc')).rejects.toThrow(/crypto\.subtle is unavailable/);
      });
    }

    it('says how to fix it, because that error is the only guidance anyone gets', async () => {
      vi.stubGlobal('crypto', undefined);

      // Nobody debugging this on a kiosk will find the README first. The message has to name both
      // the requirement and the way out.
      await expect(contentVersionOf('abc')).rejects.toThrow(/secure context/);
      await expect(contentVersionOf('abc')).rejects.toThrow(/localhost/);
      await expect(contentVersionOf('abc')).rejects.toThrow(/build/);
    });
  });
});
