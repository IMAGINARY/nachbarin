import { describe, expect, it } from 'vitest';
import { requireFlag, requireInstallationPair, requirePositiveInt } from './command.ts';

describe('requireFlag', () => {
  it('returns the value when present', () => {
    expect(requireFlag('foo', 'app')).toBe('foo');
  });

  it('throws when undefined, naming the flag', () => {
    expect(() => requireFlag(undefined, 'app')).toThrow(/Missing required --app/);
  });
});

describe('requireInstallationPair', () => {
  it('returns both values when given', () => {
    expect(requireInstallationPair({ app: 'fms', instance: 'museum-x' })).toEqual({ app: 'fms', instance: 'museum-x' });
  });

  it("defaults instance to 'default'", () => {
    expect(requireInstallationPair({ app: 'fms' })).toEqual({ app: 'fms', instance: 'default' });
  });

  it('throws when --app is missing', () => {
    expect(() => requireInstallationPair({})).toThrow(/Missing required --app/);
  });

  it('rejects invalid identifiers, naming the field', () => {
    expect(() => requireInstallationPair({ app: 'has space' })).toThrow(/Invalid app_id/);
    expect(() => requireInstallationPair({ app: 'fms', instance: "o'brien" })).toThrow(/Invalid instance_id/);
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
