import { describe, expect, it } from 'vitest';
import { formatCsv } from './csv.ts';

describe('formatCsv', () => {
  it('joins headers and cells with commas and ends with a newline', () => {
    const out = formatCsv(
      ['app', 'instance', 'total'],
      [
        ['game', 'default', '12'],
        ['survey', 'lyon', '0'],
      ],
    );
    expect(out).toBe('app,instance,total\ngame,default,12\nsurvey,lyon,0\n');
  });

  it('renders the header alone when there are no rows', () => {
    expect(formatCsv(['app', 'total'], [])).toBe('app,total\n');
  });

  it('leaves a field that needs no quoting bare', () => {
    expect(formatCsv(['a'], [['plain-value_1.0']])).toBe('a\nplain-value_1.0\n');
  });

  it('quotes a field containing a comma, so it stays one column', () => {
    expect(formatCsv(['label'], [['Museum, north hall']])).toBe('label\n"Museum, north hall"\n');
  });

  it('quotes a field containing a double quote and doubles the quote', () => {
    expect(formatCsv(['label'], [['the "big" room']])).toBe('label\n"the ""big"" room"\n');
  });

  it('quotes a field containing a newline or carriage return', () => {
    expect(formatCsv(['label'], [['line1\nline2']])).toBe('label\n"line1\nline2"\n');
    expect(formatCsv(['label'], [['line1\rline2']])).toBe('label\n"line1\rline2"\n');
  });
});
