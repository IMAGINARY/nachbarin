-- Rebuild api_keys: every key now grants exactly one installation, and the kinds are 'read' and
-- 'write'.
--
-- 0001's global read key was more authority than this service needs -- every real download is
-- "give me *my* installation's records", and full-corpus export is hand-typed operator SQL (README
-- "Operations"). 'installation' was also the wrong name for a *kind*: what a key can do is read or
-- write; the installation is what it is scoped to, which is now true of both kinds.
--
-- SQLite cannot add NOT NULL to an existing column or alter a CHECK, hence the standard table
-- rebuild. No `PRAGMA defer_foreign_keys` is needed: nothing references api_keys, so nothing
-- dangles while the old table is dropped.

CREATE TABLE api_keys_new (
  id              INTEGER PRIMARY KEY,

  -- sha256 of the presented key, lowercase hex; the key itself is never stored. See 0001 --
  -- unchanged, including the format CHECK below.
  key_hash        TEXT NOT NULL UNIQUE,

  -- No longer derivable from anything: both kinds carry an installation, so this column alone
  -- separates a key that may download from one that may only deposit.
  kind            TEXT NOT NULL CHECK (kind IN ('read', 'write')),

  -- Now mandatory for every kind -- the point of the migration. Read scope is authorization
  -- derived from the key, exactly as write scope always was, so `GET /v1/records` takes no
  -- app/instance parameters. RESTRICT, as in 0001: deleting an installation must not quietly
  -- destroy its credential trail.
  installation_pk INTEGER NOT NULL REFERENCES installations (id) ON DELETE RESTRICT,

  label           TEXT,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  revoked_at      TEXT,

  CHECK (length(key_hash) = 64 AND NOT key_hash GLOB '*[^0-9a-f]*')
);

-- Every old installation key becomes a write key, keeping its id, hash, label and revocation.
-- (Under 0001's biconditional CHECK, `kind = 'installation'` is exactly `installation_pk IS NOT
-- NULL`, so the 'write' literal is correct for every surviving row.)
--
-- The same predicate drops every old global read key -- **this migration destroys credentials**,
-- deliberately: they have no installation to be scoped to, and inventing one would silently narrow
-- or repoint a credential someone is still holding. A dropped key 401s, the same answer a revoked
-- key gets; mint a replacement per README "Minting a key".
INSERT INTO api_keys_new (id, key_hash, kind, installation_pk, label, created_at, revoked_at)
SELECT id, key_hash, 'write', installation_pk, label, created_at, revoked_at
FROM api_keys
WHERE kind = 'installation';

DROP TABLE api_keys;

ALTER TABLE api_keys_new RENAME TO api_keys;

-- No further index, as in 0001: the UNIQUE on key_hash is the auth lookup, and it stays global
-- (not partial on `revoked_at IS NULL`) so a revoked hash stays reserved forever.
