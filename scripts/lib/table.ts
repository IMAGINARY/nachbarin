/**
 * Aligned plain-text table renderer, shared by the `list` outputs (keys, installations).
 *
 * Each column is padded to the widest of its header and cells; columns are separated by two spaces and
 * trailing padding is trimmed so lines have no dangling whitespace. Pure — every cell is pre-stringified
 * by the caller — so it is unit-tested directly.
 */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cols: string[]): string =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return `${[line(headers), ...rows.map(line)].join('\n')}\n`;
}
