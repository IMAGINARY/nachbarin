/**
 * D1 adapter for {@link KeyStore}.
 *
 * One of the two seams in `storage.ts`; `d1-record-store.ts` is the other. This one sits on the
 * hotter path — every request passes through it before its body is even read.
 */

import type { Principal } from './auth';
import type { KeyStore } from './storage';

/** The one row {@link D1KeyStore.resolve} reads. */
interface KeyRow {
  readonly id: number;
  readonly kind: string;
  readonly app_id: string;
  readonly instance_id: string;
}

/**
 * A plain inner join: `installation_pk` is NOT NULL for every key, of either kind, so a row that
 * authenticates always has an installation to join to.
 *
 * `revoked_at IS NULL` is the other half of soft deletion. Forgetting it would silently resurrect
 * every revoked key ever issued.
 *
 * `k.id` is selected because the submission log records which key wrote each record, and this query
 * is the only place that number is ever in hand — the client presents a key, and the hash it maps to
 * is one-way. See `Credential` in `auth.ts`.
 */
const RESOLVE_SQL = `
  SELECT k.id, k.kind, i.app_id, i.instance_id
  FROM api_keys k
  JOIN installations i ON i.id = k.installation_pk
  WHERE k.key_hash = ?1 AND k.revoked_at IS NULL
`;

const encoder = new TextEncoder();

/**
 * sha256 of `key`, lowercase hex.
 *
 * Must agree byte for byte with `printf %s "$key" | shasum -a 256`, which is how an operator mints
 * the value stored in `api_keys.key_hash`: UTF-8, no trailing newline, lowercase. A golden fixture
 * in the tests pins that agreement, because the failure mode is a silent, permanent 401 that is by
 * design indistinguishable from revocation.
 *
 * WebCrypto rather than `node:crypto`: it is native to the runtime, and `nodejs_compat` being on
 * for other reasons is not a reason to reach for a shim.
 */
async function sha256Hex(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class D1KeyStore implements KeyStore {
  constructor(private readonly db: D1Database) {}

  async resolve(presentedKey: string): Promise<Principal | null> {
    const hash = await sha256Hex(presentedKey);

    // Deliberately not wrapped in a try/catch. A D1 failure must propagate: `null` here means 401,
    // and answering 401 to a database outage would tell every client at once that its credential is
    // bad — the one conclusion it must not draw, and one that could make a well-behaved client stop
    // retrying and discard queued records. Propagating surfaces as 500 at the error boundary in
    // `app.ts`, which is honest. `StorageUnavailableError` (503 + Retry-After) is deliberately not
    // used: it asserts the failure is transient, and a rejected `prepare` could equally be a typo in
    // the SQL above. `.first()` returns null for zero rows and throws on error, so the two cases
    // arrive through different channels and no error-message sniffing is needed.
    const row = await this.db.prepare(RESOLVE_SQL).bind(hash).first<KeyRow>();

    // No row: unknown or revoked. The query cannot tell us which, by design, and neither can the
    // caller — both are 401.
    if (row === null) return null;

    // Both kinds carry an installation and differ only by what they may do with it, so `kind` is the
    // whole mapping.
    if (row.kind === 'read' || row.kind === 'write') {
      return { kind: row.kind, appId: row.app_id, instanceId: row.instance_id, keyId: row.id };
    }

    // Unreachable while the CHECK on `kind` holds — which is the point: the schema and the type
    // system enforce one invariant from both ends. Fail closed rather than throw: a row we cannot
    // map is a row we cannot authorize. Logged, because unlike every other 401 this one means the
    // database disagrees with `Principal`.
    console.error('api_keys row does not map to a Principal', { kind: row.kind });
    return null;
  }
}
