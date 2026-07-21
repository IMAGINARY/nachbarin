import { describe, expect, it } from 'vitest';
import { assertIdentifier, escapeLiteral } from './sql.ts';

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
