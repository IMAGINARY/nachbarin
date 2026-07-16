import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { MAX_RESPONSE_BYTES } from '../src/config';
import { StorageUnavailableError } from '../src/storage';
import type { StoredRecord } from '../src/storage';
import { FIXED_RECEIVED_DATE, getRequest, KEY_READ, KEY_READ_C, makeDeps, type TestDeps } from './fakes';

interface ReadResponse {
  records: StoredRecord[];
  next_after_id: number;
  has_more: boolean;
}

function row(id: number, overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    app_id: 'app-1',
    instance_id: 'instance-a',
    client_id: `3f8a0000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`,
    created_date: '2026-07-15',
    received_date: FIXED_RECEIVED_DATE,
    engine_version: 'engine-1.4.2',
    content_version: 'sha256:ab12',
    app_data: { nodes: [['q1', 3]] },
    ...overrides,
  };
}

function seed(deps: TestDeps, count: number, overrides: (i: number) => Partial<StoredRecord> = () => ({})) {
  for (let i = 1; i <= count; i++) deps.recordStore.rows.push(row(i, overrides(i)));
}

const read = async (deps: TestDeps, query = '', key = KEY_READ) => {
  const response = await handleRequest(getRequest(query, key), deps);
  return { response, body: await response.json<ReadResponse>() };
};

describe('paging', () => {
  it('returns a page with the cursor and has_more set', async () => {
    const deps = makeDeps();
    seed(deps, 250);

    const { response, body } = await read(deps, '?limit=100');

    expect(response.status).toBe(200);
    expect(body.records).toHaveLength(100);
    expect(body.records[0].id).toBe(1);
    expect(body.next_after_id).toBe(100);
    expect(body.has_more).toBe(true);
  });

  it('walks the cursor to exhaustion with no gaps or repeats', async () => {
    const deps = makeDeps();
    seed(deps, 250);

    const seen: number[] = [];
    let cursor = 0;
    let guard = 0;

    for (;;) {
      const { body } = await read(deps, `?after_id=${String(cursor)}&limit=100`);
      seen.push(...body.records.map((r) => r.id));
      cursor = body.next_after_id;
      if (!body.has_more) break;
      if (++guard > 10) throw new Error('cursor did not terminate');
    }

    expect(seen).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(250);
  });

  it('treats after_id as an exclusive lower bound', async () => {
    const deps = makeDeps();
    seed(deps, 10);

    const { body } = await read(deps, '?after_id=7');
    expect(body.records.map((r) => r.id)).toEqual([8, 9, 10]);
    expect(body.has_more).toBe(false);
  });

  it('respects the default limit of 100', async () => {
    const deps = makeDeps();
    seed(deps, 150);
    expect((await read(deps)).body.records).toHaveLength(100);
  });
});

describe('empty pages', () => {
  // next_after_id echoes the cursor you passed in, so it is always a number. A null would force
  // every client to write a branch meaning "reuse what I already had".
  it('echoes the cursor when nothing is beyond it', async () => {
    const deps = makeDeps();
    seed(deps, 10);

    const { body } = await read(deps, '?after_id=10');
    expect(body).toEqual({ records: [], next_after_id: 10, has_more: false });
  });

  it('returns next_after_id 0 for an empty store with no cursor', async () => {
    const { body } = await read(makeDeps());
    expect(body).toEqual({ records: [], next_after_id: 0, has_more: false });
  });

  it('echoes a cursor beyond the highest id', async () => {
    const deps = makeDeps();
    seed(deps, 10);
    expect((await read(deps, '?after_id=99999')).body.next_after_id).toBe(99999);
  });
});

describe('scope', () => {
  // The installation comes from the key, so a read key is confined to its own records. `row()`
  // defaults to installation A, which is what KEY_READ grants; the others below belong elsewhere.
  it('returns only the records of the key’s own installation', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(
      row(1),
      row(2, { app_id: 'app-2', instance_id: 'instance-a' }),
      row(3),
      row(4, { app_id: 'app-1', instance_id: 'instance-b' }),
    );

    expect((await read(deps)).body.records.map((r) => r.id)).toEqual([1, 3]);
  });

  // Two read keys, one store, disjoint views. `app-2/instance-a` shares an *instance* with A and
  // differs only by app — the axis a scope keyed on instance_id alone would get wrong.
  it('gives two read keys disjoint views of the same store', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(row(1), row(2, { app_id: 'app-2', instance_id: 'instance-a' }));

    expect((await read(deps, '', KEY_READ)).body.records.map((r) => r.id)).toEqual([1]);
    expect((await read(deps, '', KEY_READ_C)).body.records.map((r) => r.id)).toEqual([2]);
  });

  // The scope is authorization, not a default to be overridden. Because unknown parameters are
  // rejected rather than ignored, asking for someone else's installation is a loud 400 rather than
  // a silently honoured or silently dropped request.
  it('400s an attempt to name an app or instance', async () => {
    const deps = makeDeps();

    for (const query of ['?app=app-2', '?instance=instance-b', '?app=app-2&instance=instance-a']) {
      const { response, body } = await read(deps, query);
      expect(response.status).toBe(400);
      expect(JSON.stringify(body)).toContain('unknown query parameter');
    }
    expect(deps.recordStore.listCalls).toBe(0);
  });

  // Paging must not leak across the scope either: the cursor is only a lower bound on id, and ids
  // are global, so an unscoped read would page straight through a neighbour's records.
  it('keeps the cursor inside the scope', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(row(1), row(2, { app_id: 'app-2', instance_id: 'instance-a' }), row(3));

    const { body } = await read(deps, '?after_id=1');
    expect(body.records.map((r) => r.id)).toEqual([3]);
    expect(body.has_more).toBe(false);
  });
});

describe('filters', () => {
  it('filters by each version field within the scope', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(
      row(1, { engine_version: 'v1', content_version: 'c1' }),
      row(2, { engine_version: 'v2', content_version: 'c2' }),
    );

    expect((await read(deps, '?engine_version=v1')).body.records.map((r) => r.id)).toEqual([1]);
    expect((await read(deps, '?content_version=c2')).body.records.map((r) => r.id)).toEqual([2]);
  });

  it('combines filters', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(
      row(1, { engine_version: 'v1', content_version: 'c1' }),
      row(2, { engine_version: 'v1', content_version: 'c2' }),
      row(3, { engine_version: 'v2', content_version: 'c1' }),
    );

    expect((await read(deps, '?engine_version=v1&content_version=c1')).body.records.map((r) => r.id)).toEqual([1]);
  });

  // Documents a known gap: SQL equality never matches NULL, so now that content_version is
  // optional there is no way to ask for "records that have none". Worth an is_null filter later.
  it('cannot select records whose content_version is null', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(row(1, { content_version: null }), row(2, { content_version: 'c1' }));

    expect((await read(deps, '?content_version=c1')).body.records.map((r) => r.id)).toEqual([2]);
    expect((await read(deps)).body.records).toHaveLength(2);
  });
});

describe('response shape', () => {
  it('includes the server-assigned id and both dates', async () => {
    const deps = makeDeps();
    seed(deps, 1);

    const { body } = await read(deps);
    expect(body.records[0]).toMatchObject({ id: 1, created_date: '2026-07-15', received_date: FIXED_RECEIVED_DATE });
  });

  // The privacy boundary, asserted on the wire rather than trusted to the schema. Records are stored
  // to a date and no finer: a precise time here would, against any other timed source, say which
  // visitor made which choice. Anything reintroducing one -- an extra column, a helpfully "richer"
  // response -- has to fail a test rather than merely contradict a comment.
  it('exposes no time of day, only dates', async () => {
    const deps = makeDeps();
    seed(deps, 1);

    const { body } = await read(deps);
    const record = body.records[0];

    expect(Object.keys(record).sort()).toEqual([
      'app_data',
      'app_id',
      'client_id',
      'content_version',
      'created_date',
      'engine_version',
      'id',
      'instance_id',
      'received_date',
    ]);
    expect(record.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('round-trips app_data byte-identically', async () => {
    const deps = makeDeps();
    const app_data = { nodes: [['q1', 3]], consent: true, note: '🎨 ünï©ode' };
    deps.recordStore.rows.push(row(1, { app_data }));

    expect((await read(deps)).body.records[0].app_data).toEqual(app_data);
  });
});

describe('byte budget', () => {
  // A full 1000 x 64KB page would be 64MB against a 128MB per-isolate budget shared across
  // concurrent requests. Short pages are safe because the cursor contract makes them
  // indistinguishable from any other page.
  it('truncates a page that exceeds the byte budget and reports has_more', async () => {
    const deps = makeDeps();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 1; i <= 200; i++) deps.recordStore.rows.push(row(i, { app_data: { blob: chunk } }));

    const { body } = await read(deps, '?limit=200');

    expect(body.records.length).toBeLessThan(200);
    expect(body.has_more).toBe(true);
    expect(body.next_after_id).toBe(body.records[body.records.length - 1].id);
    expect(JSON.stringify(body.records).length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 64 * 1024);
  });

  it('resumes correctly from a truncated page', async () => {
    const deps = makeDeps();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 1; i <= 200; i++) deps.recordStore.rows.push(row(i, { app_data: { blob: chunk } }));

    const first = await read(deps, '?limit=200');
    const second = await read(deps, `?after_id=${String(first.body.next_after_id)}&limit=200`);

    expect(second.body.records[0].id).toBe(first.body.next_after_id + 1);
  });
});

describe('read failures', () => {
  it('400s an invalid query without touching the store', async () => {
    const deps = makeDeps();
    const { response } = await read(deps, '?after=5');

    expect(response.status).toBe(400);
    expect(deps.recordStore.listCalls).toBe(0);
  });

  it('names the offending parameter so the typo is self-diagnosing', async () => {
    const { body } = await read(makeDeps(), '?foo=1');
    expect(JSON.stringify(body)).toContain('foo');
  });

  it('503s a transient storage failure', async () => {
    const deps = makeDeps();
    deps.recordStore.failWith = new StorageUnavailableError();

    const { response } = await read(deps);
    expect(response.status).toBe(503);
  });
});
