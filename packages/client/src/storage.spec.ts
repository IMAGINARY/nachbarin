import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage, resolveDefaultStorage } from './storage';

/** A Web Storage double, backed by a Map. */
function fakeWebStorage(): {
  store: Map<string, string>;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMemoryStorage', () => {
  it('round-trips', () => {
    const storage = createMemoryStorage();
    expect(storage.read()).toBeNull();
    storage.write('hello');
    expect(storage.read()).toBe('hello');
  });
});

describe('resolveDefaultStorage', () => {
  it('takes memory when there is no localStorage — Node, a Worker, Deno', () => {
    vi.stubGlobal('localStorage', undefined);

    const resolved = resolveDefaultStorage('k');
    expect(resolved.persistent).toBe(false);
    resolved.storage.write('x');
    expect(resolved.storage.read()).toBe('x');
  });

  it('takes localStorage when it works, under the key it was given', () => {
    const web = fakeWebStorage();
    vi.stubGlobal('localStorage', web);

    const resolved = resolveDefaultStorage('nachbarin.queue.v1');
    expect(resolved.persistent).toBe(true);

    resolved.storage.write('payload');
    expect(web.store.get('nachbarin.queue.v1')).toBe('payload');
    expect(resolved.storage.read()).toBe('payload');
  });

  it('leaves no probe key behind', () => {
    const web = fakeWebStorage();
    vi.stubGlobal('localStorage', web);

    resolveDefaultStorage('k');
    expect([...web.store.keys()]).toEqual([]);
  });

  it('falls back when the property access itself throws', () => {
    // A browser told to refuse site data throws SecurityError on *reading* `localStorage`, before
    // any method is called. A truthiness check would not survive this; the probe's try/catch does.
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: access is denied for this document');
      },
    });

    expect(() => resolveDefaultStorage('k')).not.toThrow();
    expect(resolveDefaultStorage('k').persistent).toBe(false);
  });

  it('falls back when the store exists but refuses to write', () => {
    // Safari private browsing historically reported a zero-byte quota: present, readable, and
    // throwing on every setItem.
    vi.stubGlobal('localStorage', {
      ...fakeWebStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });

    expect(resolveDefaultStorage('k').persistent).toBe(false);
  });

  it('falls back when the store silently discards writes', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    // The probe reads its sentinel back rather than trusting setItem to have worked.
    expect(resolveDefaultStorage('k').persistent).toBe(false);
  });

  it('propagates a later write failure rather than swallowing it', () => {
    // The queue needs to know, so it can shed records and try again. Swallowing here would make a
    // full store look exactly like a healthy one.
    let allow = true;
    vi.stubGlobal('localStorage', {
      ...fakeWebStorage(),
      setItem: () => {
        if (!allow) throw new Error('QuotaExceededError');
      },
      getItem: () => '1',
    });

    const resolved = resolveDefaultStorage('k');
    allow = false;
    expect(() => resolved.storage.write('x')).toThrow(/QuotaExceededError/);
  });
});
