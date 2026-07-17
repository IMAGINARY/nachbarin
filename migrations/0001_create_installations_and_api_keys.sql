-- Installations and the API keys that authenticate them. Two tables because they have unrelated
-- lifetimes: an installation is a durable identity that records will reference; a key is a
-- revocable credential, and one installation may legitimately hold several at once.

-- One row per (app, instance) pair -- an "installation": the identity every record belongs to, and
-- the only thing an API key can grant.
CREATE TABLE installations (
  -- Surrogate key. The natural key is (app_id, instance_id), enforced below, but references use
  -- this integer, so renaming an app or instance stays a one-row UPDATE -- and it is what makes the
  -- dedupe key unambiguous, since instance_id defaults to 'default' and scopes nothing alone. The
  -- cost is a join on every read, since app_id and instance_id are on the wire. No AUTOINCREMENT:
  -- the foreign keys pointing here already prevent a reused rowid from dangling.
  id          INTEGER PRIMARY KEY,

  -- The exhibit *app* -- the software module, usually a GitHub repository name -- never the
  -- physical exhibit.
  app_id      TEXT NOT NULL,

  -- Where the app runs: a museum, or one copy of a travelling exhibition.
  instance_id TEXT NOT NULL DEFAULT 'default',

  -- For humans. The (app_id, instance_id) pair is an identifier and should never be reworded.
  label       TEXT,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- SQLite ignores VARCHAR(n) lengths; only a CHECK enforces one (and the lower bound rejects '').
  CHECK (length(app_id) BETWEEN 1 AND 100),
  CHECK (length(instance_id) BETWEEN 1 AND 100),

  -- GitHub-repo-name charset: both values are typed by hand into shell commands and SQL, where a
  -- stray space is invisible. GLOB, not LIKE -- LIKE is case-insensitive.
  CHECK (NOT app_id GLOB '*[^a-zA-Z0-9._-]*'),
  CHECK (NOT instance_id GLOB '*[^a-zA-Z0-9._-]*'),

  UNIQUE (app_id, instance_id)
);

-- Credentials. A key is a bearer token; identity derives from it alone, never from the request.
-- (Rebuilt by 0002, which is the live account of this table: kinds and scoping changed.)
CREATE TABLE api_keys (
  id              INTEGER PRIMARY KEY,

  -- sha256 of the presented key, lowercase hex -- what `shasum -a 256` prints; the key itself is
  -- never stored. Comparison is BINARY, so the format CHECK below turns a mis-cased or padded hash
  -- into a loud INSERT error instead of a credential that 401s forever. See README for the
  -- `printf %s` vs `echo` trap, which is the other half of this.
  key_hash        TEXT NOT NULL UNIQUE,

  -- Derivable from installation_pk here, but stated anyway, so that an operator omitting the
  -- installation gets a constraint violation rather than a working global read key.
  kind            TEXT NOT NULL CHECK (kind IN ('installation', 'read')),

  -- Null exactly when kind = 'read' (the biconditional CHECK below). Named `_pk` because
  -- `instance_id` already means the TEXT business identifier one table over. RESTRICT: deleting an
  -- installation must not destroy (CASCADE) or repoint (SET NULL would *promote* the key to a
  -- global read key) its credential trail.
  installation_pk INTEGER REFERENCES installations (id) ON DELETE RESTRICT,

  -- For humans, and close to load-bearing: the hash is one-way, so this note is the only way to
  -- tell keys apart when one of them must be revoked.
  label           TEXT,

  -- RFC 3339 UTC; this strftime emits byte-identical strings to Date.prototype.toISOString()
  -- output, and the format sorts lexicographically in clock order. (CURRENT_TIMESTAMP does
  -- neither.)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Revocation is a soft delete: the row is audit evidence, and keeping it reserves the hash
  -- forever. Every reader must filter `WHERE revoked_at IS NULL`; a test pins that a revoked
  -- key 401s.
  revoked_at      TEXT,

  -- The Principal union, enforced: a key has an installation iff it is an installation key.
  CHECK ((kind = 'installation') = (installation_pk IS NOT NULL)),

  -- Exactly 64 lowercase hex characters. (A naive GLOB '[0-9a-f]*' would constrain only the first
  -- character, since `*` matches any sequence.)
  CHECK (length(key_hash) = 64 AND NOT key_hash GLOB '*[^0-9a-f]*')
);

-- No further index: the UNIQUE on key_hash is the auth lookup. Deliberately not partial on
-- `revoked_at IS NULL` -- a revoked hash must stay reserved forever.
