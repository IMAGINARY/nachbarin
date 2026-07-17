-- The records themselves: the app_data an exhibit deposits, and the least metadata that still
-- makes it analysable.
--
-- Deliberately no timestamps -- dates only. app_data is coarse by construction, but a precise
-- timestamp is not: set against camera footage or a ticket scan, it identifies who made which
-- choice. The exact times live in the submission log (0004), which has its own access privileges
-- and its own retention -- so the widest-read table in the schema is also the one that reveals
-- the least.

CREATE TABLE records (
  -- The public download cursor. AUTOINCREMENT so an id is never reused after a delete (this table
  -- gets deletions: vandalism cleanup, erasure requests): with plain max(rowid)+1 reuse, a reader
  -- already paged past that cursor would silently never see the replacement row, with both sides
  -- believing the transfer finished. Gaps are normal and meaningless -- a conflicting insert still
  -- burns a sequence value -- and `after_id` is an exclusive lower bound, so never count ids,
  -- subtract them, or infer corpus size from the newest one.
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- RESTRICT: deleting an installation must not quietly delete the evidence it ever collected
  -- anything.
  installation_pk INTEGER NOT NULL REFERENCES installations (id) ON DELETE RESTRICT,

  -- The client's UUID, and the idempotency key. See the UNIQUE at the bottom.
  client_id       TEXT NOT NULL,

  -- The date of the client's RFC 3339 created_at in the exhibit's *local* frame ('YYYY-MM-DD').
  -- That works without knowing any timezone because created_at carries an explicit offset and is
  -- never normalized to UTC (see localDateOf in validation.ts). Trusted only as far as the
  -- exhibit's clock is -- see received_date.
  created_date    TEXT NOT NULL,

  -- The date this Worker received the batch, UTC; one value per batch. Server-derived, so it keeps
  -- a broken exhibit clock detectable after the submission log's retention has passed. The two
  -- dates are in different frames (local vs UTC) and may legitimately differ by one around
  -- midnight: a skew smell test, never an exact difference.
  received_date   TEXT NOT NULL,

  engine_version  TEXT NOT NULL,

  -- Null when the app has no meaningful notion of one. Never ''.
  content_version TEXT,

  -- Compact JSON text, as validation produced it (D1 is SQLite; there is no jsonb). NOT NULL is
  -- load-bearing: a JSON `null` payload is legal and must be stored as the four characters 'null';
  -- SQL NULL would mean "no payload", a fact this protocol cannot express.
  app_data        TEXT NOT NULL,

  -- SQLite enforces neither length names nor date formats; CHECKs do both. (These GLOBs are close
  -- to D1's 50-byte pattern cap -- see 0004 before writing another.)
  CHECK (created_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (received_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- Canonical lowercase UUID. Comparison is BINARY, so without this an uppercase spelling would
  -- dodge the UNIQUE below and double-store the record. validation.ts lowercases on the way in;
  -- this guards every other write path.
  CHECK (length(client_id) = 36 AND NOT client_id GLOB '*[^0-9a-f-]*'),

  -- Mirrors MAX_VERSION_LENGTH in src/config.ts. The lower bound rejects '', which
  -- content_version expresses as NULL instead.
  CHECK (length(engine_version) BETWEEN 1 AND 256),
  CHECK (content_version IS NULL OR length(content_version) BETWEEN 1 AND 256),

  -- `list` JSON.parses every row it returns, and pages are id-ordered, so one unparseable row
  -- would wedge the download at that cursor permanently -- the reader cannot step over it.
  CHECK (json_valid(app_data)),

  -- The dedupe key. Scoped to the installation -- the (app_id, instance_id) pair -- and never to
  -- instance_id alone, which defaults to 'default': two apps at one instance would collide, and
  -- since this protocol defines `duplicate` as success, the second app's records would be silently
  -- dropped from its queue. Operational consequence: one write key must never serve two active
  -- installations, or their client_ids share a namespace they were never generated against.
  UNIQUE (installation_pk, client_id)
);

-- The read path: `WHERE installation_pk = ? AND id > ? ORDER BY id LIMIT ?` is a direct seek plus
-- walk on this index (the UNIQUE above is ordered by client_id and cannot serve it). Naming `id`
-- is documentation rather than a second column: id *is* the rowid, which SQLite appends to every
-- index entry anyway. Deliberately no index on the version columns -- they only narrow within an
-- already page-sized range, and would tax every insert.
CREATE INDEX records_by_installation ON records (installation_pk, id);
