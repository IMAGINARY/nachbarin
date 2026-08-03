/**
 * Where the queue lives between calls — and, on a kiosk, between page loads.
 *
 * ## Why the seam is synchronous
 *
 * `localStorage` is synchronous, and that is what lets `write()` return with the record already
 * durable rather than merely promised. An async seam would make `write()` async too, and every
 * caller would then have a promise to forget — in a game's click handler, on a machine that reloads
 * itself, forgetting it means losing the record.
 *
 * The cost is that IndexedDB cannot implement this interface. That is the right trade here: the
 * queue is a few dozen small records, and on hardware that is wiped nightly, durability past a page
 * reload is all that is being bought.
 *
 * ## Why detection is a probe rather than a property check
 *
 * Reading `globalThis.localStorage` can **throw** — `SecurityError` in a browser configured to
 * refuse site data, which is exactly what a locked-down kiosk profile does. And a store that exists
 * and reads fine can still refuse every write (Safari's private browsing historically reported a
 * zero-byte quota). So the probe writes a sentinel, reads it back and removes it, with the property
 * access itself inside the `try`.
 *
 * `localStorage` is banned as a bare identifier by `eslint.config.mjs` — the other half of the
 * `lib: ["DOM"]` decision in `tsconfig.json`, which is what supplies `fetch` here at the price of
 * also declaring globals that exist in exactly one of the four runtimes this package targets.
 * Reaching it through a cast on `globalThis` is the deliberate exception, the same escape hatch
 * `tsdown.config.ts` uses to read one environment variable.
 */

/** The two-method view of Web Storage that this package uses. Nothing else is touched. */
interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A place to keep one string.
 *
 * `write` is allowed to throw and callers must assume it will: a full store, a revoked quota, a
 * profile that changed its mind mid-session. What it must never do is lose data silently.
 */
export interface QueueStorage {
  read(): string | null;
  write(value: string): void;
}

/** Backed by a variable. The default in Node, and what every browser falls back to. */
export function createMemoryStorage(): QueueStorage {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next: string) => {
      value = next;
    },
  };
}

const PROBE_KEY = '__nachbarin_probe__';

function probeWebStorage(): WebStorageLike | null {
  try {
    const store = (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (store === undefined || store === null) return null;

    store.setItem(PROBE_KEY, '1');
    const readBack = store.getItem(PROBE_KEY);
    store.removeItem(PROBE_KEY);

    return readBack === '1' ? store : null;
  } catch {
    return null;
  }
}

export interface ResolvedStorage {
  readonly storage: QueueStorage;
  /** False when the queue will not survive a reload — i.e. when the fallback was taken. */
  readonly persistent: boolean;
}

/**
 * `localStorage` under `key` if it is genuinely usable here, otherwise memory.
 *
 * The fallback is silent by design. There is no runtime in which the absence of Web Storage is an
 * error — it is simply Node, or a Worker, or a browser that was told not to. Whether it *matters*
 * is the caller's call, which is why the answer comes back as `persistent` for the write client to
 * put in a diagnostic rather than this module deciding anything. (A library does not print; there
 * is no `observability.ts` on this side to route through.)
 */
export function resolveDefaultStorage(key: string): ResolvedStorage {
  const store = probeWebStorage();
  if (store === null) return { storage: createMemoryStorage(), persistent: false };

  return {
    storage: {
      read: () => store.getItem(key),
      write: (value: string) => {
        store.setItem(key, value);
      },
    },
    persistent: true,
  };
}
