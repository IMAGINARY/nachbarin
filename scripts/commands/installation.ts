import { type CommandGroup, notImplemented } from '../lib/command.ts';

// Implemented in phase 3. `delete` is guarded: it refuses unless the installation is empty (all FKs are
// ON DELETE RESTRICT), with an explicit --cascade for installations created by mistake.
export const installation: CommandGroup = {
  description: 'Installations — the (app_id, instance_id) pairs that records belong to.',
  verbs: {
    create: { summary: 'Register a new installation.', run: notImplemented(3) },
    list: { summary: 'List installations with record and key counts.', run: notImplemented(3) },
    delete: { summary: 'Delete an installation (guarded; refuses unless empty).', run: notImplemented(3) },
  },
};
