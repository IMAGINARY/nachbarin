-- The records themselves: the app_data an exhibit deposits, and the least metadata that still makes
-- it analysable.
--
-- What is *absent* here is the design. app_data is coarse by construction -- it carries choices, not
-- people -- but a precise timestamp is not coarse at all: cross-referenced against a museum's camera
-- footage, "this visitor stood here at 14:03:22" and "this record was created at 14:03:22" are the
-- same sentence. So the exact times a client reports and a server observes do not live in this
-- table. Only dates do, which is what the people processing this data actually segment by. The full
-- timestamps belong in a separate metadata table, with its own access privileges and its own
-- retention -- deliberately not here, so that the widest-read table in the schema is also the one
-- that reveals the least.
--
-- Honesty about the limit of that: `id` below is monotonic and is handed out on every read, so the
-- *order* of one installation's records stays visible, and a reader who knows the opening hours can
-- place a record within a day by its position. Date-only storage raises the cost of correlating a
-- record with a person; it does not reduce it to zero. That much is inherent in having a resumable
-- cursor at all, which the read protocol requires.

CREATE TABLE records (
  -- The download cursor, and the reason this column is not spelled like `installations.id`.
  --
  -- AUTOINCREMENT, which 0001 argued *against* for installations. That argument does not transfer:
  -- there it was about rowid reuse producing dangling references, which the foreign key already
  -- prevents. Here the hazard is different and worse. Without AUTOINCREMENT, SQLite assigns
  -- max(rowid)+1, so deleting the highest row -- a vandalised session, a GDPR erasure, both of which
  -- this table will see -- lets the *next* insert reuse that id. A reader that already paged to
  -- `after_id = N` asks for everything above N, and the new record is not above N. It would never be
  -- downloaded, no error would be raised, and both sides would believe the transfer was complete.
  -- AUTOINCREMENT keeps a high-water mark in `sqlite_sequence` and never reuses an id, which is what
  -- makes the cursor the "collision-free" thing the API spec promises.
  --
  -- Expect gaps, and do not read anything into them. A conflicting insert still consumes a sequence
  -- value, so a client retrying a batch of 100 burns 100 ids without storing a row -- and deletes
  -- leave holes by design. The cursor only ever needs to be increasing, never dense: `after_id` is an
  -- exclusive lower bound, so a gap is invisible to a reader. Nothing should count ids, subtract
  -- them, or infer how many records exist from the newest one.
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The owning installation, as the surrogate integer 0001 anticipated ("later from every row of
  -- `records`"). Not (app_id, instance_id) as text: renaming either stays a one-row UPDATE instead
  -- of a rewrite of the corpus, and it is what makes the dedupe key below unambiguous.
  --
  -- ON DELETE RESTRICT, matching api_keys: deleting an installation must not quietly delete the
  -- evidence it ever collected anything.
  installation_pk INTEGER NOT NULL REFERENCES installations (id) ON DELETE RESTRICT,

  -- The client's UUID, and the idempotency key. See the UNIQUE at the bottom.
  client_id       TEXT NOT NULL,

  -- The date the client says the record was made, in the exhibit's *local* frame -- 'YYYY-MM-DD'.
  --
  -- Derived by taking the date of the client's RFC 3339 `created_at` exactly as sent. That works
  -- without knowing any timezone: `created_at` carries an explicit offset and is never normalized to
  -- UTC, so its date and time components are already local wall-clock. The one soft spot is a client
  -- that reports in `Z` rather than its own offset, where this becomes the UTC date and can land a
  -- day early for a few hours around local midnight. Museums are shut at midnight; if one ever is
  -- not, that is a documented limitation and an operator extracts what they need by hand.
  --
  -- This column is trusted only as far as the exhibit's clock is. See `received_date`.
  created_date    TEXT NOT NULL,

  -- The date this Worker received the batch, UTC -- 'YYYY-MM-DD'. One value for a whole batch.
  --
  -- Server-derived, so unlike `created_date` it cannot be wrong. It is not an analytic field: a
  -- client may queue records for days while offline, so this is when we heard, not when it happened.
  -- It is here so that a broken exhibit clock stays *detectable* once the metadata table's retention
  -- window has passed and the full timestamps are gone: a dead RTC reporting 1970 shows up forever as
  -- a created_date absurdly far from its received_date, which is a question someone can still answer
  -- in five years. Storing only the date keeps that signal while giving up the precision that made
  -- the pair sensitive in the first place.
  --
  -- Note the two dates are in different frames (local vs UTC), so they can legitimately differ by one
  -- around midnight. They are a skew *smell test*, never an exact difference.
  received_date   TEXT NOT NULL,

  engine_version  TEXT NOT NULL,

  -- Null when the app has no meaningful notion of one. Never ''.
  content_version TEXT,

  -- The payload, as the compact JSON text validation already produced and measured.
  --
  -- TEXT, because D1 is SQLite and there is no jsonb to reach for. NOT NULL is doing real work here
  -- rather than stating the obvious: a JSON `null` is a legal, meaningful app_data, and it must be
  -- stored as the four characters 'null' and read back as JSON null. SQL NULL would be a different
  -- fact ("no payload"), which this protocol cannot express and validation never produces. NOT NULL
  -- makes the wrong one unspellable instead of merely discouraged.
  app_data        TEXT NOT NULL,

  -- SQLite does not enforce lengths in type names, and it has no date type either, so both formats
  -- are CHECKed. GLOB is anchored, so these pin the shape exactly: ten characters, digits and dashes
  -- in the one arrangement that means a date.
  CHECK (created_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (received_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- Lowercase hex and dashes, 36 characters: a canonical UUID.
  --
  -- This is the same argument as api_keys.key_hash, and the same failure mode. Comparison is BINARY,
  -- so an uppercase UUID is a *different string* -- the UNIQUE below would not fire, and the same
  -- record would be stored twice under two spellings of one id. Validation lowercases on the way in,
  -- but that is a promise made by one code path, and this table is also reachable from a psql-style
  -- session and from whatever writes to it next. The CHECK turns a silent double-store into a loud
  -- constraint violation at the moment someone is looking.
  CHECK (length(client_id) = 36 AND NOT client_id GLOB '*[^0-9a-f-]*'),

  -- Mirrors MAX_VERSION_LENGTH in src/config.ts. The lower bound rejects '', which is what
  -- `content_version` means by being NULL instead.
  CHECK (length(engine_version) BETWEEN 1 AND 256),
  CHECK (content_version IS NULL OR length(content_version) BETWEEN 1 AND 256),

  -- Cheap next to the write, and it forecloses the nastiest read failure this table has. `list`
  -- JSON.parses every row it returns. One unparseable row therefore throws on every page that
  -- contains it -- and because pages are ordered by id, the reader cannot step over it. The download
  -- would be wedged at that cursor permanently, for that installation, with a 500 and no way for the
  -- client to make progress. It also keeps an operator's json_extract() export from dying partway
  -- through the corpus.
  CHECK (json_valid(app_data)),

  -- The dedupe key, and the whole reason `installations` has a surrogate id.
  --
  -- Scoped to the installation -- the (app_id, instance_id) pair -- and never to instance_id alone,
  -- which is `default` for most apps: two apps at one museum would collide, and the second one's
  -- records would come back `duplicate`. This protocol defines `duplicate` as success, so the client
  -- would drop them from its queue. Silent, total data loss that looks healthy from both ends.
  --
  -- The cost is a real constraint on operations: one write key must not be installed in two active
  -- installations, or their client_ids share a namespace they were never generated against. UUIDs
  -- make an accidental collision vanishingly unlikely, but the constraint is what makes retrying a
  -- batch safe, and safety here should not rest on probability.
  UNIQUE (installation_pk, client_id)
);

-- The read path, and the only index this table needs beyond the UNIQUE above.
--
-- `list` is `WHERE installation_pk = ? AND id > ? ORDER BY id LIMIT ?` -- a range scan in cursor
-- order. The UNIQUE index cannot serve it: it is ordered by client_id within an installation, so it
-- would have to gather and sort the whole installation to answer one page of 100. This one is a
-- direct seek to the cursor and a walk from there. EXPLAIN QUERY PLAN confirms `SEARCH records USING
-- COVERING INDEX records_by_installation (installation_pk=? AND id>?)`.
--
-- Naming `id` is documentation rather than a second column: id *is* the rowid, and SQLite appends the
-- rowid to every index entry anyway, so `(installation_pk)` alone would build exactly this. Written
-- out, the index says what the query needs instead of leaving it to be rediscovered.
--
-- Deliberately no index on engine_version or content_version. They are optional filters that narrow
-- *within* a page-sized range scan that is already narrow; an index would earn nothing there and tax
-- every insert.
CREATE INDEX records_by_installation ON records (installation_pk, id);
