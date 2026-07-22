import { describe, expect, it } from 'vitest';
import { assertDate, assertIdentifier, escapeLiteral } from './sql.ts';

describe('assertIdentifier', () => {
  it('accepts valid app/instance identifiers', () => {
    expect(() => assertIdentifier('future-mobility-simulator', 'app_id')).not.toThrow();
    expect(() => assertIdentifier('museum-x', 'instance_id')).not.toThrow();
    expect(() => assertIdentifier('default', 'instance_id')).not.toThrow();
    expect(() => assertIdentifier('a.b_c-1', 'app_id')).not.toThrow();
    expect(() => assertIdentifier('x'.repeat(100), 'app_id')).not.toThrow();
  });

  it('rejects empty, over-long, and out-of-charset values', () => {
    expect(() => assertIdentifier('', 'app_id')).toThrow(/Invalid app_id/);
    expect(() => assertIdentifier('x'.repeat(101), 'app_id')).toThrow();
    expect(() => assertIdentifier('has space', 'app_id')).toThrow();
    expect(() => assertIdentifier("o'brien", 'app_id')).toThrow();
    expect(() => assertIdentifier('drop;table', 'app_id')).toThrow();
    expect(() => assertIdentifier('café', 'app_id')).toThrow();
  });
});

describe('escapeLiteral', () => {
  it('wraps a plain string in single quotes', () => {
    expect(escapeLiteral('Station 1, north entrance')).toBe("'Station 1, north entrance'");
  });

  it('doubles embedded single quotes', () => {
    expect(escapeLiteral("O'Brien's kiosk")).toBe("'O''Brien''s kiosk'");
  });

  it('handles the empty string', () => {
    expect(escapeLiteral('')).toBe("''");
  });
});

describe('assertDate', () => {
  it('accepts a well-formed YYYY-MM-DD date', () => {
    expect(() => assertDate('2026-07-01', 'from')).not.toThrow();
  });

  it('rejects wrong shapes, non-dates, and injection attempts', () => {
    expect(() => assertDate('2026-7-1', 'from')).toThrow(/Invalid from/);
    expect(() => assertDate('not-a-date', 'from')).toThrow();
    expect(() => assertDate("2026-07-01'; DROP TABLE records; --", 'to')).toThrow(/Invalid to/);
    expect(() => assertDate('', 'from')).toThrow();
  });

  it('is format-only, not calendar-validated (an impossible date passes the shape check)', () => {
    // Deliberate: an out-of-range filter bound just matches no rows. Contrast src/validation.ts, which
    // must reject 2026-02-30 because it guards stored data.
    expect(() => assertDate('2026-02-30', 'from')).not.toThrow();
  });
});
