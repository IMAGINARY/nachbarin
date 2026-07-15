-- Installations and the API keys that authenticate them.
--
-- These two are separate on purpose: they have unrelated lifetimes. An installation is a durable
-- fact about the world -- this app, running in that building -- and records will reference *it*. A
-- key is a credential: minted, handed to whoever is installing a station, revoked when that station
-- is stolen, replaced. An installation must survive losing every key it ever had without losing its
-- identity or its records, and one installation may legitimately hold several keys at once (a
-- multi-station exhibit gives each station its own, so one can be revoked without silencing the
-- rest). Folding them into one table would make both of those impossible.

-- One row per (app, instance) pair -- an "installation". This is the identity every record belongs
-- to, and the only thing an API key can grant.
--
-- The app-vs-instance split is deliberately not normalized further. "future-mobility-simulator" is
-- an app and "Deutsches Museum" is a place, and a third table would model that faithfully -- but
-- there is no admin UI, these rows are typed by hand, and there is one of them today. A join to
-- recover a string already sitting in the row would be cost without benefit.
CREATE TABLE installations (
  -- Surrogate key. The natural key is (app_id, instance_id), enforced below, but the reference from
  -- `api_keys` -- and later from every row of `records` -- is this integer. Renaming an app or an
  -- instance then stays a one-row UPDATE instead of a rewrite of the whole corpus. It is also what
  -- makes the dedupe key unambiguous: (installation_pk, client_id) names the pair, whereas
  -- instance_id alone does not -- it is `default` for most apps, so two apps at one instance would
  -- collide. The cost is a join on every read, since app_id and instance_id are on the wire.
  --
  -- `INTEGER PRIMARY KEY` aliases the rowid, so this is the row's physical address and that join is
  -- a direct address lookup rather than an index search.
  --
  -- No AUTOINCREMENT: it exists to stop a rowid being reused after a delete, and a dangling
  -- reference is already impossible because D1 enforces the foreign key below.
  id          INTEGER PRIMARY KEY,

  -- The exhibit *app* -- the software module -- not the exhibit as a whole. An exhibit includes
  -- furniture, hardware and wall texts; only the app talks to this API. Usually the name of a GitHub
  -- repository, whose own limit is the 100 below.
  app_id      TEXT NOT NULL,

  -- Where the app runs: a museum, or one copy of a travelling exhibition. Defaults to 'default'
  -- because most apps are installed exactly once, and demanding a ceremonial value at every insert
  -- only invites a typo in it.
  instance_id TEXT NOT NULL DEFAULT 'default',

  -- For humans. The (app_id, instance_id) pair is an identifier and should never be reworded; this
  -- is where "the station by the north entrance, contact Frau Schmidt" goes instead.
  label       TEXT,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- **SQLite does not enforce VARCHAR(100).** The length in a type name is advisory and silently
  -- ignored -- VARCHAR(100) accepts five thousand characters without complaint. A CHECK is the only
  -- construct that actually holds the line, and it gets the lower bound for free, which is what
  -- rejects '' (a length no type could express either).
  CHECK (length(app_id) BETWEEN 1 AND 100),
  CHECK (length(instance_id) BETWEEN 1 AND 100),

  -- These go on the wire as `?app=` / `?instance=` and get typed by hand into shell commands.
  -- Restricting them to the characters a GitHub repository name allows keeps them URL-safe and
  -- makes a leading space impossible to introduce invisibly. Anything expressive belongs in `label`.
  -- GLOB, not LIKE: LIKE is case-insensitive and would defeat the point.
  CHECK (NOT app_id GLOB '*[^a-zA-Z0-9._-]*'),
  CHECK (NOT instance_id GLOB '*[^a-zA-Z0-9._-]*'),

  -- The natural key: the pair the API filters on, and the pair an operator thinks in.
  UNIQUE (app_id, instance_id)
);

-- Credentials. A key is a bearer token and identity derives from it alone, so a client can neither
-- spoof nor misreport who it is.
CREATE TABLE api_keys (
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
  -- This column is *derivable* -- a key with an installation is an installation key, one without is
  -- a read key -- and it is here anyway, because the derivation fails in the one direction that
  -- matters. There is no UI in front of this table. Under derivation, an operator who forgets the
  -- installation column has not written a broken row: they have minted a working *read* key, which
  -- can bulk-download the entire corpus of every app. A typo must not be a privilege escalation.
  -- Stated explicitly, with the biconditional CHECK below, that same omission is a constraint
  -- violation instead.
  kind            TEXT NOT NULL CHECK (kind IN ('installation', 'read')),

  -- Null exactly when kind = 'read': the bulk-download identity belongs to no installation (see
  -- `ReadPrincipal`, which carries no ids at all). Named `_pk` because `instance_id` already means
  -- the TEXT business identifier one table over, and one name for two things in one schema is how a
  -- query starts lying.
  --
  -- ON DELETE RESTRICT, deliberately not CASCADE or SET NULL. CASCADE would let deleting an
  -- installation quietly destroy the credential trail. SET NULL is worse than it looks: it would
  -- turn an installation key into a read key -- *promoting* a credential as a side effect of
  -- deleting something else. RESTRICT makes the operator clear the keys out first, which is the
  -- right amount of friction for a destructive act on a hand-edited table.
  installation_pk INTEGER REFERENCES installations (id) ON DELETE RESTRICT,

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

  -- The union, enforced: a key has an installation if and only if it is an installation key. Without
  -- this, `kind` and `installation_pk` could disagree and the row would be neither arm of the
  -- TypeScript union.
  CHECK ((kind = 'installation') = (installation_pk IS NOT NULL)),

  -- 64 lowercase hex characters, exactly. `NOT ... GLOB '*[^0-9a-f]*'` reads as "contains no
  -- character outside 0-9a-f"; with the length pinned, that is an exact format check. Note a naive
  -- GLOB '[0-9a-f]*' would constrain only the FIRST character, since `*` matches any sequence.
  CHECK (length(key_hash) = 64 AND NOT key_hash GLOB '*[^0-9a-f]*')
);

-- No further index. `key_hash ... UNIQUE` already creates one, and an exact-match lookup on it is
-- precisely what authentication does; `revoked_at` then filters the single row that comes back. The
-- uniqueness is deliberately NOT partial on `revoked_at IS NULL`: a revoked hash must stay reserved
-- forever, so it has to be global.
