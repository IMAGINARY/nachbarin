import { describe, expect, it } from 'vitest';
import { matchesConfirmation } from './confirm.ts';

// confirmTyped (the readline wrapper) is exercised for real by the e2e suite, which pipes the
// confirmation string into the CLI's stdin (scripts/e2e/installation.e2e.ts).
describe('matchesConfirmation', () => {
  it('accepts an exact match', () => {
    expect(matchesConfirmation('app/default', 'app/default')).toBe(true);
  });

  it('trims surrounding whitespace from the terminal', () => {
    expect(matchesConfirmation('  app/default \n', 'app/default')).toBe(true);
  });

  it('rejects a mismatch', () => {
    expect(matchesConfirmation('app/other', 'app/default')).toBe(false);
  });

  it('is case-sensitive — the match is deliberately exact', () => {
    expect(matchesConfirmation('App/default', 'app/default')).toBe(false);
  });
});
