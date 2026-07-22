import { describe, expect, it } from 'vitest';
import { serializeExport } from './export.ts';

function row(id: number, app_data: string) {
  return {
    id,
    app_id: 'future-mobility-simulator',
    instance_id: 'm1',
    client_id: '00000000-0000-4000-8000-000000000000',
    created_date: '2026-07-01',
    received_date: '2026-07-01',
    engine_version: '1.2.0',
    content_version: null,
    app_data,
  };
}

describe('serializeExport', () => {
  it('emits NDJSON by default, one line per record, with app_data parsed to a value', () => {
    const out = serializeExport([row(1, '{"nodes":[1,5,9]}'), row(2, '{"nodes":[2]}')], { ndjson: true });
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ...row(1, ''), app_data: { nodes: [1, 5, 9] } });
    expect((JSON.parse(lines[1]) as { app_data: unknown }).app_data).toEqual({ nodes: [2] });
  });

  it('emits a single JSON array when ndjson is false', () => {
    const out = serializeExport([row(1, '{"nodes":[1]}')], { ndjson: false });
    expect(out).toContain('\n'); // pretty-printed
    expect(JSON.parse(out)).toEqual([{ ...row(1, ''), app_data: { nodes: [1] } }]);
  });

  it('round-trips a JSON null payload to null, not the string "null"', () => {
    const out = serializeExport([row(1, 'null')], { ndjson: true });
    expect((JSON.parse(out) as { app_data: unknown }).app_data).toBeNull();
  });

  it('serializes an empty result to an empty string (NDJSON) or an empty array (JSON)', () => {
    expect(serializeExport([], { ndjson: true })).toBe('');
    expect(serializeExport([], { ndjson: false })).toBe('[]');
  });
});
