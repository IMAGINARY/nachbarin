declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		/**
		 * The D1 schema, read from disk by `vitest.config.mts` and applied in `apply-migrations.ts`.
		 *
		 * Declared by hand because it is a Miniflare-only test binding: it is absent from
		 * `wrangler.jsonc`, so `wrangler types` will never put it in `Env`. `DB` needs no entry here —
		 * it is a real binding, so it arrives via `extends Env`.
		 */
		TEST_MIGRATIONS: D1Migration[];
	}
}
