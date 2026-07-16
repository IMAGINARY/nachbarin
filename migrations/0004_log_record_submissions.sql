-- The submission log: who sent what, from where, and exactly when.
--
-- This is the table 0003 promised and did not name well. Its header says the exact timestamps
-- "belong in a separate metadata table, with its own access privileges and its own retention", and
-- README, `src/storage.ts` and the OpenAPI spec all rest the whole date-only design on that
-- sentence being true one day. This is that table. 0003 cannot be edited -- migrations are history --
-- so the correction lives here: it is called a *submission log* rather than record metadata, because
-- "metadata of a record" is a claim about the grain that this table deliberately does not make.
--
-- ## The grain: one row per record per POST, duplicates included
--
-- The obvious design is 1:1 with a created record -- a row hanging off `records.id`, holding the
-- exact times that table refuses to store. That is the smallest thing that discharges 0003's
-- promise, and it is structurally blind to most of what anyone opens this table to find out.
--
-- `records` deduplicates with ON CONFLICT DO NOTHING, so a resubmission changes nothing and leaves
-- no trace anywhere. Under a 1:1 design, all of these are invisible:
--
--   * An exhibit whose queue has stopped draining -- the same client_ids resubmitted forever,
--     every one acknowledged as `duplicate`, which this protocol defines as success. From the
--     outside the museum looks healthy and is uploading nothing.
--   * A captured batch replayed from somewhere else. Same client_ids, different IP. Silently
--     absorbed as duplicates.
--   * A client resending a client_id with *different* app_data -- a bug, or someone editing
--     payloads. DO NOTHING keeps the first and discards the second without a word.
--
-- All three are exactly the "abnormal records, possibly the product of vandalism" case this table
-- exists for, and all three are events that happen *without a record being created*. So the row is
-- about the submission, not about the record. A submission happened whether or not it created
-- anything, and whether or not what it created still exists.
--
-- Nothing is lost by the wider grain: per-record metadata is a view over this one. The earliest row
-- for a given (installation_pk, client_id) is by construction the submission that created the
-- record -- every later one conflicted. So the log is a superset of the 1:1 table, not an
-- alternative to it.
--
-- The cost, stated plainly rather than discovered later: a client stuck in a retry loop writes rows
-- proportional to the loop, not to the data. Do the arithmetic honestly, because it does not come
-- out where you would like. 100 records every 10 seconds is ~864k rows/day; over the 90-day window
-- that is ~78M rows, and at ~320 bytes each, **~25 GB against D1's 10 GB per-database limit**. The
-- sweep does not save that scenario -- it bounds the table at two and a half times the ceiling. The
-- honest number is the other way round: **this table fills D1 at a sustained ~4 records/second**,
-- for one database, and the sweep is what makes 4/s a ceiling rather than a countdown.
--
-- Four per second, continuously, for three months, is several orders of magnitude above any museum
-- -- a busy exhibit is thousands of records a *day*, which is tens of megabytes a quarter. So this
-- is a real ceiling and not a real risk, and the distinction matters: the failure is not gradual.
-- D1 answers `Exceeded maximum DB size`, and because these rows share the record insert's
-- transaction, that error rolls the batch back. Ingestion stops -- brought down by the table that
-- exists to explain why things stop.
--
-- What is genuinely reassuring is smaller than "it won't happen": the storm above takes ~36 days to
-- fill the database from empty, and a storm that size is the loudest signal this table can carry.
-- That is five weeks of an exhibit uploading nothing and saying so, in a table someone would be
-- reading for exactly that reason. If it is ever approached, the lever is the retention window --
-- 30 days holds a third as much and answers most of the same questions.
--
-- ## Why there is no record_id, and no foreign key to `records`
--
-- Partly mechanical. `ON CONFLICT DO NOTHING` returns no id when it conflicts, and `meta.last_row_id`
-- then holds a stale value from an earlier statement rather than anything about this one -- reading
-- it positionally would attach provenance to the wrong record, silently. Recovering the id needs
-- RETURNING, which needs the metadata insert to be a *second* round trip, which puts it outside the
-- record insert's transaction. That gap is a real state: records commit, metadata fails, the client
-- gets a 500 and retries, every record comes back `duplicate`, and that submission's provenance is
-- gone forever. It also makes a debugging aid into an availability dependency for ingestion.
--
-- But the mechanics only rule out an implementation. The reason there is nothing to reference is the
-- grain: a submission is not a record. Keying by (installation_pk, client_id) -- column for column
-- the natural key `records` already deduplicates on -- makes this statement fully independent of the
-- record insert. Same batch, same transaction, one round trip, no ordering constraint between them,
-- no ON CONFLICT, and no way to resurrect a purged row.
--
-- And both foreign-key behaviours would be wrong here, which is the tell that the FK itself is the
-- mistake:
--
--   * ON DELETE RESTRICT -- the house rule everywhere else in this schema -- would block the exact
--     deletions 0003 says this data will see ("a vandalised session, a GDPR erasure, both of which
--     this table will see"). An operator's DELETE FROM records would simply fail.
--   * ON DELETE CASCADE is worse, and backwards. You delete a vandalised record *because you suspect
--     it*. These rows are the evidence of who sent it. CASCADE destroys that evidence at the precise
--     instant you act on the suspicion -- the exact inversion of what the house rule is for
--     ("deleting an installation must not quietly delete the evidence it ever collected anything").
--
-- A row here outliving its record is therefore the feature, not a dangling reference. It is
-- self-describing: it still says "at 14:03:22.104 on 2026-07-15, 203.0.113.9 (AS3320, Munich)
-- submitted client_id 3f8a... under key 4", and that sentence is most worth having precisely when
-- the record is gone. 0001's no-AUTOINCREMENT argument was about rowid reuse producing dangling
-- references; there are no references here at all.
--
-- ## Every CHECK here must already be true before it is written
--
-- This is the constraint that shapes the whole table, and it inverts this schema's usual instinct.
--
-- These rows are written in the *same batch, and therefore the same transaction*, as the records
-- they describe. So a CHECK that fires is not a rejected metadata row. It is a rolled-back batch, a
-- 500, a client that retries, another 500 -- forever. Permanent, total data loss for that
-- installation, from a server that looks healthy and a table that only exists to help. It is the
-- write-path twin of the wedge `json_valid(app_data)` prevents on the read path in 0003.
--
-- Two rules follow, and every CHECK below obeys them:
--
--   1. A CHECK may only restate something the code already guarantees -- `validation.ts` for
--      created_at and client_id, `provenance.ts` for everything from the edge, crypto.randomUUID()
--      for submission_id. Then it can only fire if the code and the schema have come to disagree
--      with each other, which is a bug worth stopping, and never because the world surprised us.
--   2. Nothing sourced from the edge is shape-checked -- only *bounded*, and the bound is enforced
--      by clamping in `provenance.ts` first, so the CHECK is unreachable rather than merely unlikely.
--
-- Or: **a forensics table must not refuse to record something because it looks wrong. Looking wrong
-- is the point.**
--
-- ## What is here is the venue, not the visitor
--
-- The IP and the geo columns describe the exhibit's building and its ISP -- a cable and an address
-- that is already on the museum's website. They are not about visitors, and they are not what makes
-- this table sensitive.
--
-- The precise `created_at` is. It is the field 0003 removed from `records` and the reason this table
-- is admin-only and swept at 90 days: set beside camera footage or a ticket scan, "this visitor
-- stood here at 14:03:22" and "this record was created at 14:03:22" are the same sentence. Every
-- other column here is in service of answering an operational question about a machine.
--
-- That frame is why `latitude`, `longitude` and `postalCode` are absent, though Cloudflare offers
-- all three:
--
--   * They add nothing over `cf_city`. IP geolocation resolves to an ISP's centroid, not a position.
--   * They are strings in the runtime (not numbers), so the one thing anyone would ever do with them
--     -- compare, measure, bound -- silently compares lexicographically: '9.5' > '10.1'.
--   * Best reason: every column here has to survive the question "why do you have this?". A reviewer
--     who stops on `latitude` never reaches the argument for the timestamp, which is the one that
--     actually matters. Keep this table's answer short enough to be read to the end.
--
-- ## Adding a column later is cheap, which is why this list is short
--
-- Nothing here is capture-it-or-lose-it. The sweep empties the table every 90 days, so a column
-- added later is *fully populated within 90 days* and the gap closes by itself. That is the exact
-- opposite of `records`, where a field not captured at write time is gone forever, and it means the
-- bar for a column here is "answers a question we actually have", not "might be useful someday".
-- `region`, `httpProtocol`, `isEUCountry`, `tlsVersion` and a denormalized `outcome` all fail that
-- bar today and cost one migration and three months to add on the day they stop failing it.
--
-- One table rather than a normalized `submissions` + `record_metadata` pair, for the reason 0001
-- already gave about not splitting out app/instance: "a join to recover a string already sitting in
-- the row would be cost without benefit". The per-POST facts repeat on every row, at roughly 3x the
-- storage of the normalized form -- on a table bounded at 90 days, against a three-way join in every
-- hand-typed admin query. The rows cannot disagree with each other: one JS value is bound into all
-- of them inside one transaction.

CREATE TABLE record_submissions (
  -- No AUTOINCREMENT -- the third table to make this call, for the third different reason.
  --
  -- 0001 (installations) declined it because the hazard was a reused rowid leaving a dangling
  -- reference, which the foreign key already prevented. 0003 (records) required it because that
  -- argument did not transfer: `records.id` is the public download cursor, and reusing an id after a
  -- delete silently strands a reader who has already paged past it.
  --
  -- Neither transfers here. Nothing references this id -- there is no inbound foreign key, by design,
  -- see the header -- and nothing pages this table: there is no cursor, no reader holding an
  -- after_id, no protocol. Reuse is not merely possible here but routine, since the daily sweep
  -- empties the table for any installation silent for 90 days, and it is harmless because no one
  -- outside the row is holding the number.
  id                 INTEGER PRIMARY KEY,

  -- The POST this row arrived in. One UUID minted per request, shared by every record in it.
  --
  -- This is what makes "one submission" a thing you can query: GROUP BY submission_id gives batch
  -- sizes, retry storms, and "these arrived together" -- none of which is recoverable from the rows
  -- alone.
  --
  -- Not derived from (installation_pk, received_at). Workers freezes the clock during synchronous
  -- execution, so two concurrent POSTs from one installation can carry a byte-identical received_at
  -- and would silently merge into one apparent submission. `records`' own UNIQUE comment already
  -- settled how this schema feels about that: safety here should not rest on probability.
  submission_id      TEXT NOT NULL,

  -- The installation, as everywhere else. ON DELETE RESTRICT matches api_keys and records; it costs
  -- nothing, since `records` already restricts that same delete.
  installation_pk    INTEGER NOT NULL REFERENCES installations (id) ON DELETE RESTRICT,

  -- *Which key* wrote this, which no other table can tell you afterwards.
  --
  -- 0001 wrote the argument for this column while defending `label`: "when one station's tablet is
  -- stolen, the operator must revoke *that* key and not the others -- without a note written at
  -- creation time, the only safe move is to revoke everything and re-key the building." An
  -- installation legitimately holds several keys at once (0001 again: "a multi-station exhibit gives
  -- each station its own"), so installation_pk cannot answer it. With this column, "which key is
  -- writing from that IP, from that country, at 3am" is a query, and revocation becomes surgical
  -- instead of a re-key of the building.
  --
  -- A surrogate id on a Principal, which `d1-record-store.ts` argues against for the installation
  -- ("carries the business pair and deliberately not a schema surrogate"). That argument is about a
  -- thing that *has* a business key to carry instead. A key's natural identifier is a hash we have
  -- deliberately made irreversible; this id is the only handle on it that exists.
  --
  -- ON DELETE RESTRICT is free here and does real work: keys are soft-deleted via `revoked_at` and
  -- never removed, so this can only fire if someone breaks that convention -- at which point it
  -- stops them, which is the right answer.
  key_id             INTEGER NOT NULL REFERENCES api_keys (id) ON DELETE RESTRICT,

  -- The other half of the join back to `records`, and not unique here. See the index below.
  client_id          TEXT NOT NULL,

  -- The client's RFC 3339 timestamp, byte for byte as sent -- offset and all, never normalized.
  --
  -- This is the column the table exists for, and the one thing here `records` structurally cannot
  -- hold. `records.created_date` is a slice(0, 10) of this value; the rest of it lives here, behind
  -- different privileges, for 90 days.
  --
  -- Verbatim matters twice over. The offset is what makes `created_date` a *local* date without any
  -- timezone being configured anywhere (see `localDateOf`), so preserving it here is what lets an
  -- operator reconstruct that reasoning later -- and, against cf_timezone below, check it.
  created_at         TEXT NOT NULL,

  -- When this Worker took the batch, UTC, full precision. `Date.prototype.toISOString()` output.
  --
  -- The exact time behind `records.received_date`, and the sweep's clock: retention is measured from
  -- when we heard, which is a fact about us, rather than from created_at, which an exhibit with a
  -- dead RTC reports as 1970 and would have us delete on arrival.
  received_at        TEXT NOT NULL,

  -- Everything below is what the edge told us about the connection, and every one of them is
  -- nullable: `request.cf` is undefined under test unless a test supplies it, and each field within
  -- it is independently optional in production. A missing value is a fact about the request, not an
  -- error -- see the header on why nothing here may refuse a row.
  --
  -- (`wrangler dev` is the other way round: it fetches the *real* properties, so running the service
  -- locally files your own city and ISP under whatever installation you POST to. Harmless in a local
  -- database, worth knowing before reading one.)

  -- From CF-Connecting-IP. The exhibit's address, which in practice is the museum's NAT gateway.
  client_ip          TEXT,

  -- Self-reported, and useful *because* it is: it is the difference between "the engine posted this"
  -- and "curl posted this". It proves nothing alone -- anyone can set it -- but a mismatch against
  -- the equally self-reported `records.engine_version` is a fact, and whoever forges one usually
  -- forgets the other.
  user_agent         TEXT,

  -- ISO 3166-1 alpha-2, or 'T1' for Tor. `provenance.ts` nulls anything that is not two characters,
  -- which is what makes the length CHECK below unreachable.
  cf_country         TEXT,
  cf_city            TEXT,

  -- The ISP, as the stable number and the human label -- the same id/label pattern `installations`
  -- and `api_keys` already use. 3320 means nothing to anyone; "Deutsche Telekom AG" means "the
  -- museum's provider" and "M247 Ltd" means "someone is on a VPN", and neither is recoverable from
  -- the number without a lookup nobody will do at 3am.
  cf_asn             INTEGER,
  cf_as_organization TEXT,

  -- The Cloudflare datacenter that took the request (IATA, e.g. 'FRA'). The "why did the connection
  -- stop working" signal that geo does not give: an exhibit that starts landing in a different colo
  -- has had a routing change, and a colo that disagrees with cf_country is a proxy smell.
  cf_colo            TEXT,

  -- IANA timezone of the client IP, e.g. 'Europe/Berlin'.
  --
  -- The quiet one. This repo worries in four places (0003's header, `localDateOf`, README, the
  -- OpenAPI spec) that an app might report `Z` instead of its real offset, and every time concludes
  -- it is a permanent limitation -- because nothing we hold could contradict the exhibit's own claim
  -- about itself. This column can: it is derived from the IP, independently of anything the exhibit
  -- says. created_at's offset versus cf_timezone is a *checkable* claim.
  --
  -- It is also what makes an existing README promise true. "An operator who genuinely needs those
  -- hours can extract them with SQL against the metadata table" -- without this column they could
  -- not, having the exact time but still stuck in the wrong frame, with nothing to recover local
  -- wall-clock from.
  cf_timezone        TEXT,

  -- crypto.randomUUID() is lowercase v4. Same idiom, and same reasoning, as records.client_id.
  CHECK (length(submission_id) = 36 AND NOT submission_id GLOB '*[^0-9a-f-]*'),

  -- The same CHECK as records.client_id, guarding a *new* failure mode. This is half the join key
  -- back to that table, and comparison is BINARY: an uppercase spelling here joins to nothing. A
  -- broken join does not raise -- it returns fewer rows, quietly, and the answer looks like "no
  -- provenance was recorded" rather than "you cannot spell". `validation.ts` lowercases on the way
  -- in, so this only fires if that stops being true.
  CHECK (length(client_id) = 36 AND NOT client_id GLOB '*[^0-9a-f-]*'),

  -- Deliberately looser than it looks, and every loose part is load-bearing. See the header: this
  -- CHECK shares a transaction with the record insert, so anything it rejects that `validation.ts`
  -- accepts is a permanent 500 for that client, not a rejected row.
  --
  -- `[Tt]`, not a literal 'T': RFC3339_RE accepts a lowercase 't' (and 'z'), and validateCreatedAt
  -- returns the string *verbatim*, so '2026-07-15t14:03:22z' is a legal record today. GLOB is
  -- case-sensitive, so pinning 'T' here would wedge that client forever.
  --
  -- Nothing past the seconds is checked, and no length is bounded: the regex allows unbounded
  -- fractional digits and either 'Z'/'z' or a numeric offset. Pinning anything validation does not
  -- pin is the same wedge wearing a different hat. What is checked is the part that is fixed-width
  -- in every accepted value, and not one character more.
  --
  -- **Split across two GLOBs because D1 caps a GLOB pattern at 50 bytes** -- see the note below the
  -- table. The whole timestamp as one pattern is 79 bytes and fails at runtime, not at migration
  -- time, which is the worst possible place for it to fail. substr() also does the bounding the
  -- trailing '*' used to, so this is the plainer statement of the same rule.
  CHECK (substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (substr(created_at, 11, 9) GLOB '[Tt][0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),

  -- The one timestamp we produce ourselves, so it can be pinned exactly -- and the asymmetry with
  -- the two lines above is the point, not an inconsistency. toISOString() has one shape,
  -- byte-identical to strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), which is what makes this comparable to
  -- api_keys.created_at and what makes the sweep's lexicographic `<` exact.
  --
  -- Three GLOBs rather than one, for the 50-byte reason above: the full 24-character shape is a
  -- 92-byte pattern. The length() is what makes the pieces add up to the whole -- without it,
  -- substr() past the end returns '' and the tail GLOB would have nothing to object to.
  --
  -- GLOB's only metacharacters are * ? and []; the '.' below is a literal dot.
  CHECK (
    length(received_at) = 24
    AND substr(received_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(received_at, 11, 9) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
    AND substr(received_at, 20) GLOB '.[0-9][0-9][0-9]Z'
  ),

  -- Bounded, never shaped. 45 is an IPv6 address with an IPv4 tail, the longest form there is.
  -- Deliberately no format check: a shape rule on a value we do not produce is a 500 wedge waiting
  -- for the first legal value we failed to anticipate, and recording the thing nobody anticipated is
  -- this table's entire job.
  CHECK (client_ip IS NULL OR length(client_ip) BETWEEN 1 AND 45),

  -- Each of these restates a clamp `provenance.ts` has already applied, so none of them is reachable
  -- from a request. They are here to catch this table and that module drifting apart.
  CHECK (cf_country IS NULL OR length(cf_country) = 2),
  CHECK (cf_city IS NULL OR length(cf_city) BETWEEN 1 AND 128),
  CHECK (cf_as_organization IS NULL OR length(cf_as_organization) BETWEEN 1 AND 128),
  -- Not `= 3`. IATA codes are three characters today, and today is not a constraint.
  CHECK (cf_colo IS NULL OR length(cf_colo) BETWEEN 1 AND 8),
  CHECK (cf_timezone IS NULL OR length(cf_timezone) BETWEEN 1 AND 64),
  -- Truncation is deliberate upstream: a clipped user agent is still forensically useful, and a
  -- wedged installation is not.
  CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),

  -- 0001's "VARCHAR(100) does not enforce 100" argument, reaching the schema's one numeric column --
  -- though the obvious version of it is wrong, and the real one is narrower.
  --
  -- `INTEGER` is an affinity, not a type, so the tempting claim is that the string '3320' lands here
  -- intact and compares unequal to 3320 forever. It does not: affinity *converts* a well-formed
  -- integer literal, so '3320' is stored as the integer 3320 and `WHERE cf_asn = 3320` finds it.
  -- That case needs no defending.
  --
  -- What affinity will not touch is anything that is not well-formed. 'AS3320' and '3320abc' stay
  -- TEXT; 3320.5 stays REAL; and an integer too large for 64 bits silently becomes REAL (1.0e+22).
  -- Each of those sits in this column looking like an ASN and comparing equal to no integer at all,
  -- which is the silent version of the failure and the one worth a constraint. typeof() is the only
  -- construct that sees it, exactly as CHECK is the only one that sees a length.
  --
  -- Not hypothetical merely because the runtime declares `asn: number`: this value is `unknown` at
  -- the boundary, and the declaration describes a good day. `provenance.ts` rejects non-integers,
  -- which is what makes this unreachable rather than merely unlikely.
  CHECK (cf_asn IS NULL OR (typeof(cf_asn) = 'integer' AND cf_asn > 0))
);

-- **D1 caps a GLOB pattern at 50 bytes**, and this is where that was found out.
--
-- Stock SQLite allows 50,000 (SQLITE_LIMIT_LIKE_PATTERN_LENGTH); D1 compiles it far lower. The
-- limit is on the *pattern's* length in bytes, not the subject's, and `[0-9]` costs five of them --
-- so a pattern runs out at ten character classes. Over the line, every evaluation fails with
-- "LIKE or GLOB pattern too complex: SQLITE_ERROR".
--
-- Two things make this worth writing down rather than rediscovering:
--
--   * **It fails at INSERT, not at migration time.** `wrangler d1 migrations apply` accepts a table
--     whose CHECK can never be evaluated -- the pattern is only compiled when a row arrives. On this
--     table, in this transaction, that is the permanent-500 wedge the header is about. A CHECK
--     written to protect the write path would have been the thing breaking it.
--   * **0003 is at 42 bytes**, eight from the cliff, and reads like it has room. It does not. Any
--     date or timestamp format check in this schema is nearly out of budget already, and the next
--     one to be written will look reasonable and fail.
--
-- The way out is substr() plus several short patterns, as above: it costs a line and states the
-- same rule, positionally, in pieces that are individually under the cap. `test/d1-record-store.spec.ts`
-- pins the limit itself, so it is a failing test rather than a puzzle if D1 ever moves it.

-- The join back to `records`, and the reason the grain works.
--
-- Column for column the same as records' own UNIQUE (installation_pk, client_id), so recovering a
-- record's exact times is an index seek on both sides rather than a scan of either.
--
-- **Deliberately not UNIQUE, and that single difference is the whole grain argument.** One
-- (installation, client_id) appears once per submission of it, and that repetition is not
-- redundancy -- it is the content: the retry storm, the replay from another address, the resend with
-- a mutated payload. Making this UNIQUE would enforce the 1:1 design the header rejects, and would
-- do it by rolling back the batch.
CREATE INDEX record_submissions_by_record ON record_submissions (installation_pk, client_id);

-- The retention sweep (`DELETE ... WHERE received_at < ?`), and "what was the first record from the
-- new venue" (ORDER BY received_at).
--
-- Rejected alternative: lean on rowid order and skip this index. Rows do arrive in roughly
-- received_at order, so `DELETE WHERE id <= (SELECT MAX(id) WHERE received_at < ?)` looks
-- equivalent and is free. Rejected because that ordering is an accident of arrival rather than
-- anything enforced -- one concurrent batch, one clock adjustment, and it is false -- and the
-- failure mode is rows living past their retention window forever with nothing to notice. The one
-- guarantee this table owes anyone is the one that must not rest on an accident.
CREATE INDEX record_submissions_by_received_at ON record_submissions (received_at);

-- No index on cf_country, cf_city, client_ip or key_id, for the reason 0003 gives about
-- engine_version: they are ad-hoc filters over a table already bounded at 90 days, run by hand a
-- handful of times a year, and an index on each would tax every single record write to speed them.
--
-- The two above are not free either, and the price is worth naming: they are two extra B-tree writes
-- on every record ingested. received_at is monotonic, so that one is a cheap right-append;
-- (installation_pk, client_id) is a random insert. That is the standing cost of this table existing,
-- paid on the hot path, and it buys the read path nothing at all.
