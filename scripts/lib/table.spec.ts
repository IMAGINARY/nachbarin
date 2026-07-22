import { describe, expect, it } from 'vitest';
import { formatTable } from './table.ts';

describe('formatTable', () => {
  it('pads each column to the widest of its header and cells and separates with two spaces', () => {
    const out = formatTable(
      ['ID', 'LABEL'],
      [
        ['1', 'north hall'],
        ['200', 'x'],
      ],
    );
    expect(out).toBe(['ID   LABEL', '1    north hall', '200  x'].join('\n') + '\n');
  });

  it('trims trailing padding so the last column has no dangling whitespace', () => {
    const out = formatTable(['A', 'B'], [['xx', 'y']]);
    // Header row's second column ("B") is padded to width 1, so no trailing spaces on either line.
    expect(out).toBe('A   B\nxx  y\n');
    expect(out.split('\n').every((l) => l === l.trimEnd())).toBe(true);
  });

  it('renders the header alone when there are no rows', () => {
    expect(formatTable(['ID', 'APP'], [])).toBe('ID  APP\n');
  });

  it('widens a column when a cell is longer than its header', () => {
    const out = formatTable(['K', 'V'], [['x', 'a-very-long-value']]);
    expect(out).toBe('K  V\nx  a-very-long-value\n');
  });
});
