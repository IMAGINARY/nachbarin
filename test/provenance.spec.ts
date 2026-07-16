/**
 * `provenanceOf` — a pure function of the request, tested like `validation.ts` and for the same
 * reason: it is the whole boundary between what the edge says and what the database stores.
 *
 * The thing under test is mostly what it does with values it did not expect. `request.cf` is
 * undefined under test unless a test supplies it, every field in it is independently optional in
 * production, and each one arrives as `unknown` rather than its declared type. These rows are written
 * in the records' own transaction, so a field this function mishandles is not a bad column — it is a
 * rejected batch and a wedged installation. Almost every case below must produce a null and never a
 * throw; the two that must produce a null and are easy to get wrong — an ASN too big for SQLite, and
 * an astral character JS miscounts — are the ones with a CHECK waiting on the other side.
 */

import { describe, expect, it } from 'vitest';
import { provenanceOf } from '../src/provenance';

const SUBMISSION_ID = '5c7e0000-0000-4000-8000-00000000ffff';

const CF = {
  country: 'DE',
  city: 'Munich',
  asn: 3320,
  asOrganization: 'Deutsche Telekom AG',
  colo: 'FRA',
  timezone: 'Europe/Berlin',
};

/** `cf` is typed loosely on purpose — this file's whole job is passing values the types disallow. */
function request(cf?: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/v1/records', { method: 'POST', headers, cf: cf as never });
}

const of = (cf?: Record<string, unknown>, headers?: Record<string, string>) => provenanceOf(request(cf, headers), SUBMISSION_ID);

describe('provenanceOf', () => {
  it('reads every field the edge supplied', () => {
    const result = of(CF, { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'nachbarin-engine/1.4.2' });

    expect(result).toEqual({
      submissionId: SUBMISSION_ID,
      clientIp: '203.0.113.9',
      userAgent: 'nachbarin-engine/1.4.2',
      country: 'DE',
      city: 'Munich',
      asn: 3320,
      asOrganization: 'Deutsche Telekom AG',
      colo: 'FRA',
      timezone: 'Europe/Berlin',
    });
  });

  // The default under test, and not an edge case: no `cf`, no Cloudflare headers. (`wrangler dev` is
  // the opposite — it fetches real ones — so this is the shape production must never rely on.)
  it('nulls everything when there is no cf and no headers', () => {
    expect(of(undefined)).toEqual({
      submissionId: SUBMISSION_ID,
      clientIp: null,
      userAgent: null,
      country: null,
      city: null,
      asn: null,
      asOrganization: null,
      colo: null,
      timezone: null,
    });
  });

  it('passes the submission id through untouched', () => {
    expect(of(CF).submissionId).toBe(SUBMISSION_ID);
  });

  it('nulls each cf field independently when it is absent', () => {
    for (const field of Object.keys(CF)) {
      const partial = { ...CF };
      delete partial[field as keyof typeof CF];

      // Every other field still arrives; only the removed one is null.
      const result = of(partial) as unknown as Record<string, unknown>;
      const key = field === 'asOrganization' ? 'asOrganization' : field;
      expect(result[key], `${field} removed`).toBeNull();
      expect(result.city ?? result.country, `${field} removed, others survive`).not.toBeUndefined();
    }
  });

  // `Headers.get` is case-insensitive, so the wire spelling must not matter. Worth pinning because
  // the failure is a silently null column rather than an error.
  it('reads CF-Connecting-IP whatever its case', () => {
    expect(of(undefined, { 'CF-CONNECTING-IP': '203.0.113.9' }).clientIp).toBe('203.0.113.9');
    expect(of(undefined, { 'Cf-Connecting-Ip': '203.0.113.9' }).clientIp).toBe('203.0.113.9');
  });

  describe('values the runtime types say are impossible', () => {
    // Each field is `unknown` at this boundary. The declared types describe a good day, and on a good
    // day this function has nothing to do.
    it('nulls an asn that is not a number', () => {
      expect(of({ ...CF, asn: '3320' }).asn).toBeNull();
      expect(of({ ...CF, asn: null }).asn).toBeNull();
      expect(of({ ...CF, asn: {} }).asn).toBeNull();
    });

    // A non-integer would land in an INTEGER column as REAL and compare equal to no ASN ever after.
    it('nulls an asn that is not a positive integer', () => {
      expect(of({ ...CF, asn: 3320.5 }).asn).toBeNull();
      expect(of({ ...CF, asn: 0 }).asn).toBeNull();
      expect(of({ ...CF, asn: -1 }).asn).toBeNull();
      expect(of({ ...CF, asn: Number.NaN }).asn).toBeNull();
    });

    // `Number.isInteger(1e21)` is true — it is a legitimate JS integer, and far outside SQLite's
    // 64-bit range, so it would land as REAL and trip the schema's typeof() CHECK. On this table
    // that is a rolled-back batch, not a null column, so the magnitude bound is what keeps the CHECK
    // unreachable. ASNs are 32-bit, so nothing above that was ever an ASN.
    it('nulls an asn too large to be one, which is still a JS integer', () => {
      expect(of({ ...CF, asn: 1e21 }).asn).toBeNull();
      expect(of({ ...CF, asn: 0xffffffff + 1 }).asn).toBeNull();
      // The top of the range is a real ASN and must survive.
      expect(of({ ...CF, asn: 0xffffffff }).asn).toBe(0xffffffff);
    });

    it('nulls a country that is not two characters', () => {
      expect(of({ ...CF, country: 'DEU' }).country).toBeNull();
      expect(of({ ...CF, country: 'D' }).country).toBeNull();
      expect(of({ ...CF, country: 5 }).country).toBeNull();
    });

    // `'𝕏'.length === 2` in JS but SQLite's `length()` says 1, so a `.length === 2` guard would pass
    // this straight into a `length(cf_country) = 2` CHECK and wedge the batch. cf_country is the
    // only bound in the schema that is an equality, which is why it is the only one exposed to this.
    it('nulls an astral character that JS counts as two units', () => {
      expect('𝕏'.length).toBe(2);
      expect(of({ ...CF, country: '𝕏' }).country).toBeNull();
    });

    // Tor. A real value that looks like a bug, which is exactly what this table must not discard.
    it('keeps T1, the Tor pseudo-country', () => {
      expect(of({ ...CF, country: 'T1' }).country).toBe('T1');
    });

    it('nulls a string field that is not a string', () => {
      expect(of({ ...CF, city: 42 }).city).toBeNull();
      expect(of({ ...CF, colo: ['FRA'] }).colo).toBeNull();
      expect(of({ ...CF, timezone: {} }).timezone).toBeNull();
    });

    // '' would violate the schema's `length BETWEEN 1 AND n`, and it already has a spelling: NULL.
    it('nulls an empty or blank string rather than storing it', () => {
      expect(of({ ...CF, city: '' }).city).toBeNull();
      expect(of({ ...CF, city: '   ' }).city).toBeNull();
      expect(of(undefined, { 'cf-connecting-ip': '' }).clientIp).toBeNull();
    });
  });

  describe('clamping, which is what makes the schema CHECKs unreachable', () => {
    it('truncates an over-long user agent rather than dropping it', () => {
      const result = of(undefined, { 'user-agent': 'u'.repeat(10_000) });

      expect(result.userAgent).toHaveLength(512);
    });

    it('truncates the other bounded fields to their column widths', () => {
      const result = of({
        ...CF,
        city: 'c'.repeat(500),
        asOrganization: 'o'.repeat(500),
        colo: 'x'.repeat(50),
        timezone: 't'.repeat(500),
      });

      expect(result.city).toHaveLength(128);
      expect(result.asOrganization).toHaveLength(128);
      expect(result.colo).toHaveLength(8);
      expect(result.timezone).toHaveLength(64);
    });

    it('truncates an over-long client ip', () => {
      expect(of(undefined, { 'cf-connecting-ip': '9'.repeat(200) }).clientIp).toHaveLength(45);
    });
  });

  // Not a validator. There is no input that makes this throw, because throwing here would take
  // ingestion down at the exact moment something unusual is happening.
  it('never throws, whatever cf contains', () => {
    expect(() => of({ country: {}, city: [], asn: 'x', asOrganization: 0, colo: null, timezone: false })).not.toThrow();
  });
});
