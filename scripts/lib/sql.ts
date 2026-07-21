/**
 * SQL identifier validation and literal escaping for the operator CLI.
 *
 * `wrangler d1 execute` has no parameter binding — every value is interpolated into the SQL string by
 * hand. These two helpers are the audited choke point for that: identifiers are validated against the
 * schema's own rule and rejected if they stray; free-form text is escaped. Nothing else in the CLI
 * should splice a value into SQL without going through here.
 */

// Mirrors the CHECKs on installations.app_id / instance_id in
// migrations/0001_create_installations_and_api_keys.sql:
//   length(...) BETWEEN 1 AND 100  AND  NOT ... GLOB '*[^a-zA-Z0-9._-]*'
// Duplicated here (with this citation) because src/ exports no identifier rule to import. Keep the two
// in agreement: if the migration's charset or length ever changes, change this too.
const IDENTIFIER_RE = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Throws unless `value` is a valid installation identifier (app_id / instance_id). `field` names the
 * offending argument in the error, since the operator typed it by hand.
 */
export function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${field}: ${JSON.stringify(value)}. Must be 1-100 characters of [a-zA-Z0-9._-] ` +
        `(matches the installations CHECK in migration 0001).`,
    );
  }
}

/**
 * Escapes a string as a single-quoted SQL literal: doubles embedded single quotes and wraps the result
 * in quotes. For free-form TEXT columns (a key or installation label), which carry no charset CHECK and
 * so may legitimately contain apostrophes.
 */
export function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
