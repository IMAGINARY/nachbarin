/**
 * nachbarin operator CLI — dispatcher and top-level help.
 *
 * A single entry point with noun-verb subcommands (`node scripts/cli.ts <noun> <verb> [options]`), so one
 * `--help` enumerates the whole operator surface and the shared helpers in lib/ are reused everywhere.
 * Routing is hand-rolled — the repo's ethos is zero runtime dependencies. Per-command flag parsing (in
 * later phases) uses `node:util` parseArgs inside each command; the dispatcher only pulls out the noun,
 * the verb, and the global flags.
 *
 * The pure pieces (parseInvocation, resolve, helpText) are exported for unit testing. `main` runs only
 * when this file is the process entry point, so importing the module in a test has no side effects.
 */

import { pathToFileURL } from 'node:url';
import type { CommandContext, CommandGroup, Handler } from './lib/command.ts';
import { installation } from './commands/installation.ts';
import { key } from './commands/key.ts';
import { log } from './commands/log.ts';
import { record } from './commands/record.ts';
import { exportRecords } from './commands/export.ts';

/** The whole operator surface: noun → command group. `export` is a reserved word, so its module export
 * is `exportRecords`; the noun is still `export`. */
export const commands: Record<string, CommandGroup> = {
  installation,
  key,
  log,
  record,
  export: exportRecords,
};

export interface Invocation {
  noun?: string;
  verb?: string;
  remote: boolean;
  help: boolean;
  /** Everything after the verb (extra positionals and command flags), verbatim, for the command. */
  rest: string[];
}

/**
 * Splits argv into the noun, the verb, the global flags, and the remainder. Global `--remote`/`--local`
 * and `--help`/`-h` are recognized anywhere; the first two bare words are the noun and verb; everything
 * else is handed to the command untouched. Pure, so dispatch is unit-testable.
 */
export function parseInvocation(argv: string[]): Invocation {
  let remote = false;
  let help = false;
  const positionals: string[] = [];
  const rest: string[] = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--remote') {
      remote = true;
    } else if (arg === '--local') {
      remote = false;
    } else if (positionals.length < 2 && !arg.startsWith('-')) {
      positionals.push(arg);
    } else {
      rest.push(arg);
    }
  }

  return { noun: positionals[0], verb: positionals[1], remote, help, rest };
}

export interface Resolution {
  noun: string;
  verb: string;
  run: Handler;
}

/**
 * Resolves a (noun, verb) pair to its handler, or returns an `{ error }` describing what was wrong. Pure,
 * so it can be exercised without running a command.
 */
export function resolve(noun: string | undefined, verb: string | undefined): Resolution | { error: string } {
  if (noun === undefined || !(noun in commands)) {
    return { error: `Unknown command: ${noun ?? '(none)'}` };
  }
  const group = commands[noun];
  if (verb === undefined || !(verb in group.verbs)) {
    return { error: `Unknown ${noun} subcommand: ${verb ?? '(none)'}` };
  }
  return { noun, verb, run: group.verbs[verb].run };
}

/** Renders the full noun-verb surface for `--help`. */
export function helpText(): string {
  const lines = ['nachbarin operator CLI', '', 'Usage: node scripts/cli.ts <command> <subcommand> [options]', ''];
  for (const [noun, group] of Object.entries(commands)) {
    lines.push(`${noun} — ${group.description}`);
    for (const [verb, def] of Object.entries(group.verbs)) {
      lines.push(`  ${`${noun} ${verb}`.padEnd(26)}${def.summary}`);
    }
    lines.push('');
  }
  lines.push('Global options:');
  lines.push('  --remote   target the production database (default: local)');
  lines.push('  --help     show this help');
  return lines.join('\n');
}

async function main(argv: string[]): Promise<void> {
  const inv = parseInvocation(argv);

  if (inv.help || inv.noun === undefined) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const resolution = resolve(inv.noun, inv.verb);
  if ('error' in resolution) {
    process.stderr.write(`${resolution.error}\n\n${helpText()}\n`);
    process.exitCode = 1;
    return;
  }

  const ctx: CommandContext = { args: inv.rest, remote: inv.remote };
  await resolution.run(ctx);
}

// Run only when invoked directly (`node scripts/cli.ts …`), not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
