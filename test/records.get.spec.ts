import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { MAX_RESPONSE_BYTES } from '../src/config';
import { StorageUnavailableError } from '../src/storage';
import type { StoredRecord } from '../src/storage';
import { getRequest, KEY_READ, makeDeps, type TestDeps } from './fakes';

interface ReadResponse {
  records: StoredRecord[];
  next_after_id: number;
  has_more: boolean;
}

function row(id: number, overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    exhibit_id: 'exhibit-1',
    installation_id: 'install-a',
    client_id: `3f8a0000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`,
    created_at: '2026-07-15T14:03:22+02:00',
    received_at: '2026-07-15T12:00:00.000Z',
    engine_version: 'engine-1.4.2',
    content_version: 'sha256:ab12',
    app_data: { nodes: [['q1', 3]] },
    ...overrides,
  };
}

function seed(deps: TestDeps, count: number, overrides: (i: number) => Partial<StoredRecord> = () => ({})) {
  for (let i = 1; i <= count; i++) deps.recordStore.rows.push(row(i, overrides(i)));
}

const read = async (deps: TestDeps, query = '') => {
  const response = await handleRequest(getRequest(query, KEY_READ), deps);
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

describe('filters', () => {
  it('filters by each identity and version field', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(
      row(1, { exhibit_id: 'e1', installation_id: 'i1', engine_version: 'v1', content_version: 'c1' }),
      row(2, { exhibit_id: 'e2', installation_id: 'i2', engine_version: 'v2', content_version: 'c2' }),
    );

    expect((await read(deps, '?exhibit=e1')).body.records.map((r) => r.id)).toEqual([1]);
    expect((await read(deps, '?installation=i2')).body.records.map((r) => r.id)).toEqual([2]);
    expect((await read(deps, '?engine_version=v1')).body.records.map((r) => r.id)).toEqual([1]);
    expect((await read(deps, '?content_version=c2')).body.records.map((r) => r.id)).toEqual([2]);
  });

  it('combines filters', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(
      row(1, { installation_id: 'i1', content_version: 'c1' }),
      row(2, { installation_id: 'i1', content_version: 'c2' }),
      row(3, { installation_id: 'i2', content_version: 'c1' }),
    );

    expect((await read(deps, '?installation=i1&content_version=c1')).body.records.map((r) => r.id)).toEqual([1]);
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
  it('includes the server-assigned id and received_at', async () => {
    const deps = makeDeps();
    seed(deps, 1);

    const { body } = await read(deps);
    expect(body.records[0]).toMatchObject({ id: 1, received_at: '2026-07-15T12:00:00.000Z' });
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
