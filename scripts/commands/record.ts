import { type CommandGroup, notImplemented } from '../lib/command.ts';

// Implemented in phase 4. `erase` deletes a record and its submission-log rows; the log rows are located
// via the record, so they are deleted first (as in the README recipe). Not one transaction — same as today.
export const record: CommandGroup = {
  description: 'Records — erasure of a stored record and its submission-log rows.',
  verbs: {
    erase: { summary: 'Delete a record by id, plus its record_submissions rows.', run: notImplemented(4) },
  },
};
