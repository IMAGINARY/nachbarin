/**
 * Public entry point for the nachbarin client.
 *
 * Nothing here talks to the service yet — this pass built the packaging, not the protocol. The
 * shape below is a placeholder chosen to exercise every piece of that packaging: an exported type
 * (so the .d.ts has something to bundle), an exported function (so the CJS/ESM split and
 * tree-shaking have something to carry), and a `fetch` reference (so a build failure tells us the
 * isomorphic type setup is wrong now rather than us discovering it later).
 */

export interface ClientOptions {
  /** Base URL of the service, e.g. `https://nachbarin.example.workers.dev`. */
  readonly baseUrl: string;
  /**
   * A `read` or `write` API key. Which of the two it is, and which installation it covers, are
   * properties of the key itself — the service takes identity and scope from it alone, never from
   * a request body or query string. There is nothing to configure here.
   */
  readonly apiKey: string;
  /**
   * Injection point for the transport. Defaults to the global `fetch`, which exists in every
   * runtime this package targets; tests and exotic hosts pass their own.
   */
  readonly fetch?: typeof globalThis.fetch;
}

export interface Client {
  /** The service origin, normalized from `ClientOptions.baseUrl`. */
  readonly baseUrl: string;
}

export function createClient(options: ClientOptions): Client {
  return { baseUrl: new URL(options.baseUrl).origin };
}
