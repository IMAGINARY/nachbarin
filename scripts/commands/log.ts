import { type CommandGroup, notImplemented } from '../lib/command.ts';

// Implemented in phase 4. These are the operator-only submission-log queries (record_submissions has no
// HTTP endpoint). They only render; they must not "clean up" the verbatim edge data they read.
export const log: CommandGroup = {
  description: 'Submission log — operator-only diagnostics over record_submissions.',
  verbs: {
    'last-seen': { summary: 'Last contact per installation (why a venue went quiet).', run: notImplemented(4) },
    'first-record': { summary: 'First submission from an installation.', run: notImplemented(4) },
    'key-activity': { summary: 'What a given key has been doing.', run: notImplemented(4) },
    'stale-batches': { summary: 'Submissions with an unusually high record count (stuck queues).', run: notImplemented(4) },
    'record-time': { summary: 'Exact submission time(s) for one record id.', run: notImplemented(4) },
  },
};
