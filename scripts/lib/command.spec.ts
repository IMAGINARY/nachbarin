import { describe, expect, it } from 'vitest';
import { requireFlag, requirePositiveInt } from './command.ts';

describe('requireFlag', () => {
  it('returns the value when present', () => {
    expect(requireFlag('foo', 'app')).toBe('foo');
  });

  it('throws when undefined, naming the flag', () => {
    expect(() => requireFlag(undefined, 'app')).toThrow(/Missing required --app/);
  });
});

describe('requirePositiveInt', () => {
  it('parses a positive integer', () => {
    expect(requirePositiveInt('1', 'id')).toBe(1);
    expect(requirePositiveInt('184002', 'id')).toBe(184002);
  });

  it('rejects zero, negatives, non-integers, and non-numbers', () => {
    expect(() => requirePositiveInt('0', 'id')).toThrow(/Invalid --id/);
    expect(() => requirePositiveInt('-3', 'id')).toThrow();
    expect(() => requirePositiveInt('1.5', 'id')).toThrow();
    expect(() => requirePositiveInt('abc', 'id')).toThrow();
    expect(() => requirePositiveInt('', 'id')).toThrow();
  });
});
