import { type CommandGroup, notImplemented } from '../lib/command.ts';

// Implemented in phase 2. `mint` generates the key, stores only its sha256 hash, and prints the key once;
// `revoke` takes a label, never the key. A golden-hash parity test pins the script's hashing against the
// fixtures in test/seed.ts.
export const key: CommandGroup = {
  description: 'API keys — installation-scoped read/write credentials.',
  verbs: {
    mint: { summary: 'Generate a key, store its hash, and print the key once.', run: notImplemented(2) },
    list: { summary: 'List keys for an installation, including revocation state.', run: notImplemented(2) },
    revoke: { summary: 'Revoke a key by label (soft-delete via revoked_at).', run: notImplemented(2) },
  },
};
