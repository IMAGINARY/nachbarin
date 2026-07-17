-- The submission log: who sent what, from where, and exactly when. This is the "separate metadata
-- table" 0003 pointed the exact timestamps at; it is operator-only (no endpoint) and swept after
-- 90 days, because a precise created_at set against camera footage or a ticket scan identifies a
-- visitor -- the reason 0003 stores dates only.
--
-- ## The grain: one row per submitted record per POST, duplicates included
--
-- `records` dedupes with ON CONFLICT DO NOTHING, so a resubmission stores nothing and would
-- otherwise leave no trace -- yet a queue that stopped draining, a replayed batch, and a resend
-- with mutated app_data are exactly what this table exists to reveal, and all three happen without
-- a record being created. So the row is about the submission, not the record. Per-record metadata
-- is a view over this: the earliest row per (installation_pk, client_id) is by construction the
-- creating submission. The cost of the grain is that a client stuck in a retry loop writes rows
-- proportional to the loop, not to the data; the 90-day sweep and the per-record cap
-- (MAX_SUBMISSIONS_PER_RECORD, src/config.ts) bound that.
--
-- ## No record_id, and no foreign key to `records`
--
-- The natural key (installation_pk, client_id) joins back to `records` without coupling the two
-- inserts (ON CONFLICT DO NOTHING returns no id to reference). Both FK behaviours would also be
-- wrong: RESTRICT would block the vandalism/erasure deletions `records` expects, and CASCADE would
-- destroy the evidence of who sent a record at the precise moment it is deleted on suspicion. A
-- row here outliving its record is the feature, not a dangling reference.
--
-- ## Every CHECK here must already be guaranteed by the code
--
-- These rows are written in the *same transaction* as the records they describe, so a CHECK that
-- fires is not a rejected log row: it is a rolled-back batch, a 500, a retry, another 500 --
-- forever. Every CHECK below only restates what the code already produces (`validation.ts`,
-- `provenance.ts`, crypto.randomUUID), so it can only fire when code and schema have drifted
-- apart. Edge-sourced values are *bounded*, never shape-checked, and `provenance.ts` clamps to the
-- bound first. A forensics table must not refuse to record something because it looks wrong --
-- looking wrong is the point.

CREATE TABLE record_submissions (
  -- No AUTOINCREMENT: nothing references this id (no inbound FK, see above) and nothing pages this
  -- table, so reuse after the sweep is routine and harmless.
  id                 INTEGER PRIMARY KEY,

  -- One UUID minted per POST, shared by every record in it -- what makes "one submission" a thing
  -- you can GROUP BY (batch sizes, retry storms, "these arrived together"). Not derived from
  -- (installation_pk, received_at): Workers freezes the clock during synchronous execution, so two
  -- concurrent POSTs can carry byte-identical timestamps.
  submission_id      TEXT NOT NULL,

  installation_pk    INTEGER NOT NULL REFERENCES installations (id) ON DELETE RESTRICT,

  -- *Which key* wrote this, which no other table can tell you afterwards: an installation may hold
  -- several keys at once, so this is what makes revocation after an incident surgical instead of a
  -- re-key of the building. RESTRICT is free -- keys are soft-deleted, never removed -- and stops
  -- whoever breaks that convention.
  key_id             INTEGER NOT NULL REFERENCES api_keys (id) ON DELETE RESTRICT,

  -- Half the join key back to `records`; deliberately not unique here (see the index below).
  client_id          TEXT NOT NULL,

  -- The client's RFC 3339 timestamp, byte for byte as sent -- offset and all, never normalized.
  -- records.created_date is a slice(0, 10) of this value; the rest of it lives here, behind
  -- different privileges, for 90 days.
  created_at         TEXT NOT NULL,

  -- When this Worker took the batch: Date.prototype.toISOString() output, and the sweep's clock --
  -- retention is measured from when we heard, not from a client clock that a dead RTC reports
  -- as 1970.
  received_at        TEXT NOT NULL,

  -- Everything below is what the edge reported about the connection, and each field is nullable:
  -- `request.cf` is undefined under test unless supplied, and every field in it is independently
  -- optional in production. A missing value is a fact about the request, not an error. (Note that
  -- `wrangler dev` fetches *real* values, so local POSTs file your own city and ISP.)

  -- From CF-Connecting-IP -- in practice the museum's NAT gateway, not a visitor.
  client_ip          TEXT,

  -- Self-reported; proves nothing alone, but a mismatch against the equally self-reported
  -- records.engine_version is a fact.
  user_agent         TEXT,

  -- ISO 3166-1 alpha-2, or 'T1' for Tor.
  cf_country         TEXT,
  cf_city            TEXT,

  -- The ISP, as the stable number and the human label: "Deutsche Telekom AG" means "the museum's
  -- provider", "M247 Ltd" means "someone is on a VPN".
  cf_asn             INTEGER,
  cf_as_organization TEXT,

  -- The Cloudflare datacenter that took the request (IATA, e.g. 'FRA'): a routing-change and
  -- proxy-smell signal that geo does not give.
  cf_colo            TEXT,

  -- IANA timezone of the client IP, e.g. 'Europe/Berlin'. Derived independently of anything the
  -- exhibit says, so created_at's offset becomes a *checkable* claim -- and it is what lets an
  -- operator recover local wall-clock hours by SQL when they genuinely need them.
  cf_timezone        TEXT,

  -- crypto.randomUUID() is lowercase v4; same idiom as records.client_id.
  CHECK (length(submission_id) = 36 AND NOT submission_id GLOB '*[^0-9a-f-]*'),

  -- Comparison is BINARY, and this is half the join key back to `records`: an uppercase spelling
  -- would join to nothing, quietly reading as "no provenance recorded". validation.ts lowercases
  -- on the way in, so this only fires if that stops being true.
  CHECK (length(client_id) = 36 AND NOT client_id GLOB '*[^0-9a-f-]*'),

  -- Deliberately loose, and every loose part is load-bearing: RFC3339_RE accepts a lowercase
  -- 't'/'z' and unbounded fractional seconds, and validateCreatedAt returns the string *verbatim*,
  -- so only the fixed-width prefix every accepted value shares is checked -- [Tt], and no length
  -- pin. Anything stricter than validation.ts is a permanent-500 wedge (see the header). Split
  -- across two GLOBs because of D1's 50-byte pattern cap (see below); substr() also does the
  -- bounding a trailing '*' would.
  CHECK (substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (substr(created_at, 11, 9) GLOB '[Tt][0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),

  -- The one timestamp we produce ourselves, so it is pinned exactly: toISOString() has one
  -- 24-character shape, byte-identical to strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), which is what
  -- makes the sweep's lexicographic `<` exact. Three GLOBs for the same 50-byte reason; the
  -- length() is what makes the substr() pieces add up to the whole (substr() past the end returns
  -- '', which the tail GLOB could not object to). GLOB's only metacharacters are * ? and [] --
  -- the '.' below is a literal dot.
  CHECK (
    length(received_at) = 24
    AND substr(received_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(received_at, 11, 9) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
    AND substr(received_at, 20) GLOB '.[0-9][0-9][0-9]Z'
  ),

  -- Bounded, never shaped: 45 is an IPv6 address with an IPv4 tail, the longest form there is.
  -- A format check on a value we do not produce would be a 500 wedge waiting for the first legal
  -- value nobody anticipated.
  CHECK (client_ip IS NULL OR length(client_ip) BETWEEN 1 AND 45),

  -- Each of these restates a clamp provenance.ts has already applied, so none is reachable from a
  -- request; they catch this table and that module drifting apart.
  CHECK (cf_country IS NULL OR length(cf_country) = 2),
  CHECK (cf_city IS NULL OR length(cf_city) BETWEEN 1 AND 128),
  CHECK (cf_as_organization IS NULL OR length(cf_as_organization) BETWEEN 1 AND 128),
  -- Not `= 3`. IATA codes are three characters today, and today is not a constraint.
  CHECK (cf_colo IS NULL OR length(cf_colo) BETWEEN 1 AND 8),
  CHECK (cf_timezone IS NULL OR length(cf_timezone) BETWEEN 1 AND 64),
  -- Truncation is deliberate upstream: a clipped user agent is still forensically useful, and a
  -- wedged installation is not.
  CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),

  -- INTEGER affinity converts a well-formed literal ('3320' becomes 3320 and needs no defending)
  -- but leaves 'AS3320' as TEXT, a float as REAL, and an int64 overflow as REAL -- each comparing
  -- equal to no integer, silently. typeof() is the only construct that sees it. provenance.ts
  -- rejects non-integers first, which is what makes this unreachable.
  CHECK (cf_asn IS NULL OR (typeof(cf_asn) = 'integer' AND cf_asn > 0))
);

-- **D1 caps a GLOB pattern at 50 bytes** (stock SQLite allows 50,000), and `[0-9]` costs five of
-- them -- ten character classes is the entire budget. Over it, every evaluation fails with "LIKE
-- or GLOB pattern too complex" **at INSERT, not at migration time**: `wrangler d1 migrations
-- apply` happily accepts a CHECK that can never be evaluated, and on this table that is the
-- permanent-500 wedge the header is about. The way out is substr() plus several short patterns,
-- as above. `test/d1-record-store.spec.ts` pins the limit itself, so it is a failing test rather
-- than a puzzle if D1 ever moves it.

-- The join back to `records` -- column for column its UNIQUE (installation_pk, client_id), so
-- recovering a record's exact times is an index seek on both sides. **Deliberately not UNIQUE**:
-- one (installation, client_id) appears once per submission of it, and that repetition is the
-- content (see the grain, above). Making it UNIQUE would enforce the 1:1 design by rolling back
-- the batch.
CREATE INDEX record_submissions_by_record ON record_submissions (installation_pk, client_id);

-- The retention sweep (`DELETE ... WHERE received_at < ?`) and first/last-arrival queries. Rowid
-- order only approximates arrival order -- one concurrent batch or clock adjustment breaks it --
-- so the sweep must not lean on it.
CREATE INDEX record_submissions_by_received_at ON record_submissions (received_at);

-- No index on cf_country, cf_city, client_ip or key_id: ad-hoc filters over a table bounded at 90
-- days, run by hand a few times a year, not worth taxing every insert. The two above already cost
-- two extra B-tree writes per record ingested; that is the standing price of this table.
