import { type CommandGroup, notImplemented } from '../lib/command.ts';

// Implemented in phase 4. Cross-installation export is an operator SQL query, deliberately not an API
// capability (no token spans installations). The single verb reads records across installations by date.
export const exportRecords: CommandGroup = {
  description: 'Export — cross-installation record export (operator-only).',
  verbs: {
    records: { summary: 'Export records across installations by date range (JSON).', run: notImplemented(4) },
  },
};
