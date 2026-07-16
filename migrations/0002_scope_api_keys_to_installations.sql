-- Every API key now grants exactly one installation, and the kinds are 'read' and 'write'.
--
-- 0001 made the two kinds asymmetric: an 'installation' key was scoped to one (app_id, instance_id)
-- pair and could only write, while a 'read' key had no installation at all and could download every
-- app's records. That global read key is more authority than this service needs -- every real
-- download is "give me *my* installation's records" -- and it is authority that leaks with the
-- credential. Genuine full-corpus export is rare, irreversible operator work, which is the same
-- category as minting a key: it belongs in `wrangler d1 execute`, next to the rest of the
-- hand-typed SQL, not behind an HTTP token. See README "Operations".
--
-- 'installation' was also simply the wrong name for a *kind*. The two things a key can do are read
-- and write; "installation" is what a key is scoped *to*, which is now true of both kinds.
--
-- SQLite cannot add NOT NULL to an existing column, and cannot alter a CHECK, so `api_keys` gets
-- the standard table rebuild. No `PRAGMA defer_foreign_keys` is needed: `api_keys` has an outgoing
-- foreign key to `installations`, but nothing references `api_keys`, so nothing dangles while the
-- old table is dropped. (That pragma is D1's documented escape hatch if that ever stops being true.)
--
-- One note on a rationale that lives in 0001 and cannot be corrected there, since 0001 is a
-- historical record and does not touch this table: the charset CHECKs on installations.app_id and
-- installations.instance_id are justified by "they go on the wire as `?app=` / `?instance=`". Those
-- query parameters are gone. The CHECKs stay, and now stand on the plainer ground that both values
-- are typed by hand into shell commands and pasted into SQL, where a leading space is invisible and
-- unfalsifiable. The README states the live version.

CREATE TABLE api_keys_new (
  id              INTEGER PRIMARY KEY,

  -- sha256 of the presented key, lowercase hex. The key itself is never stored, so a dump of this
  -- table leaks no usable credential. A plain hash rather than a password KDF: these are
  -- high-entropy random tokens, so brute-forcing is not the threat a KDF defends against, and this
  -- sits on the hottest path we have.
  --
  -- Hex rather than base64 or a BLOB because keys are minted by hand: `shasum -a 256` prints exactly
  -- this, so the operator produces the value with a tool already on their machine.
  --
  -- The CHECK earns its place. Comparison here is BINARY (the default collation), so an uppercase or
  -- whitespace-padded hash is simply a hash that never matches -- and a key that never matches is a
  -- 401, which this API deliberately makes indistinguishable from a revoked key. That is an
  -- unfalsifiable bug report at 3am. Rejecting the bad spelling at INSERT turns it into a loud error
  -- at the one moment someone is looking. See README for the `printf %s` vs `echo` trap, which is
  -- the other half of this.
  key_hash        TEXT NOT NULL UNIQUE,

  -- Mirrors the `Principal` union in `src/auth.ts`.
  --
  -- 0001 kept this column while conceding it was *derivable* -- a key with an installation was an
  -- installation key, one without was a read key -- on the grounds that an operator who forgot
  -- `installation_pk` would otherwise mint a working global read key by accident, and a typo must
  -- not be a privilege escalation. Both halves of that argument are now obsolete, in opposite
  -- directions. `kind` is no longer derivable from anything: both kinds carry an installation, so
  -- this column is the only thing that separates a key that may download from a key that may only
  -- deposit. And the omission it defended against is now a NOT NULL violation one column down.
  --
  -- So the column is load-bearing for the simplest possible reason: it is the fact itself, and
  -- nothing else in the row implies it.
  kind            TEXT NOT NULL CHECK (kind IN ('read', 'write')),

  -- The installation this key grants -- now mandatory, for every kind. This is the whole point of
  -- the migration: read scope is authorization, derived from the key, exactly as write scope always
  -- was. `GET /v1/records` reads app and instance from here and takes no app/instance parameters.
  --
  -- Named `_pk` because `instance_id` already means the TEXT business identifier one table over, and
  -- one name for two things in one schema is how a query starts lying.
  --
  -- ON DELETE RESTRICT, deliberately not CASCADE: CASCADE would let deleting an installation quietly
  -- destroy the credential trail. RESTRICT makes the operator clear the keys out first, which is the
  -- right amount of friction for a destructive act on a hand-edited table. SET NULL was the other
  -- rejected option in 0001, because it would have *promoted* an installation key into a global read
  -- key as a side effect of deleting something else; NOT NULL now makes that unspellable, which is a
  -- small bonus of requiring the column.
  --
  -- NOT NULL also replaces 0001's biconditional CHECK ((kind = 'installation') = (installation_pk IS
  -- NOT NULL)). There is no longer a proposition to enforce: every key has an installation.
  installation_pk INTEGER NOT NULL REFERENCES installations (id) ON DELETE RESTRICT,

  -- For humans, and close to load-bearing. sha256 is one-way: once the key is handed over, this row
  -- is 64 characters of opacity with no other handle on it. When one station's tablet is stolen, the
  -- operator must revoke *that* key and not the others -- without a note written at creation time,
  -- the only safe move is to revoke everything and re-key the building.
  label           TEXT,

  -- SQLite has no date type. RFC 3339 in UTC as TEXT is already this repo's convention (`received_at`
  -- is `Date.prototype.toISOString()` output), and this DEFAULT emits byte-identical strings to it:
  -- same shape, same millisecond precision, same trailing Z. CURRENT_TIMESTAMP is deliberately not
  -- used -- it yields 'YYYY-MM-DD HH:MM:SS', which is neither RFC 3339 nor comparable to anything
  -- else we store. The format also sorts lexicographically in clock order.
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Revocation is a soft delete. `KeyStore.resolve` must answer identically for an unknown key and a
  -- revoked one -- both are 401 -- but that is a promise about what we tell the *client*, not an
  -- instruction to forget. A hard DELETE would discard the only evidence the key ever existed, at
  -- precisely the moment (a leak, a stolen tablet, an audit) when "whose key was this, and when did
  -- we kill it?" is the question being asked. Keeping the row also reserves the hash forever, and
  -- makes an accidental revocation a one-word UPDATE rather than a re-key of the building.
  --
  -- The cost is a predicate that must never be forgotten:
  --     WHERE key_hash = ?1 AND revoked_at IS NULL
  -- There is exactly one query that reads this table, and a test pins that a revoked key 401s.
  revoked_at      TEXT,

  -- 64 lowercase hex characters, exactly. `NOT ... GLOB '*[^0-9a-f]*'` reads as "contains no
  -- character outside 0-9a-f"; with the length pinned, that is an exact format check. Note a naive
  -- GLOB '[0-9a-f]*' would constrain only the FIRST character, since `*` matches any sequence.
  CHECK (length(key_hash) = 64 AND NOT key_hash GLOB '*[^0-9a-f]*')
);

-- Every old installation key becomes a write key, keeping its id, hash, label and revocation.
--
-- `WHERE kind = 'installation'` is exactly `installation_pk IS NOT NULL` under 0001's biconditional
-- CHECK, so the 'write' literal is provably correct for every surviving row rather than a guess.
--
-- The same predicate drops every old read key, and that is deliberate: **this migration destroys
-- credentials.** A global read key has no installation to be scoped to, and inventing one would
-- silently narrow a credential someone is still holding -- or, worse, silently point it at the wrong
-- installation's data. Dropping it means the key 401s, which is the honest answer and the one this
-- API already gives for a revoked key. Mint a replacement per README "Minting a key"; there are no
-- read keys outside local testing at the time of writing.
INSERT INTO api_keys_new (id, key_hash, kind, installation_pk, label, created_at, revoked_at)
SELECT id, key_hash, 'write', installation_pk, label, created_at, revoked_at
FROM api_keys
WHERE kind = 'installation';

DROP TABLE api_keys;

ALTER TABLE api_keys_new RENAME TO api_keys;

-- No further index, for the same reason as 0001: `key_hash ... UNIQUE` already creates one, an
-- exact-match lookup on it is precisely what authentication does, and `revoked_at` then filters the
-- single row that comes back. The uniqueness is deliberately NOT partial on `revoked_at IS NULL`: a
-- revoked hash must stay reserved forever, so it has to be global.
