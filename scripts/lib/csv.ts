/**
 * RFC 4180 CSV renderer — the machine-readable peer of formatTable, same signature, so a command picks a
 * renderer and changes nothing else.
 *
 * A field is quoted only when it has to be: a double quote, comma, CR or LF forces quoting, and embedded
 * quotes are doubled. `record stats` cannot produce any of those (identifiers carry a charset CHECK and the
 * counts are integers), but a free-form column — an installation or key label — is one caller away, and a
 * label with a comma in it must not silently shift every following column. Pure, so it is unit-tested
 * directly.
 */
export function formatCsv(headers: string[], rows: string[][]): string {
  const field = (value: string): string => (/["\r\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const line = (cols: string[]): string => cols.map(field).join(',');
  return `${[line(headers), ...rows.map(line)].join('\n')}\n`;
}
