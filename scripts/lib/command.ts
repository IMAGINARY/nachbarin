/**
 * The command contract shared by the dispatcher (cli.ts) and every command module (commands/*.ts).
 *
 * Kept in lib/ so cli.ts and the command modules both depend on it without depending on each other —
 * cli.ts imports the command groups, the command groups import only these types and helpers.
 */

/** The parsed global context handed to every command handler. */
export interface CommandContext {
  /** Positional args and command-specific flags after the noun and verb, verbatim, for the command
   * to parse with `node:util` parseArgs when it is implemented. */
  args: string[];
  /** Whether `--remote` was given. The default target is local, mirroring the repo's deliberate lack
   * of a db:migrate:remote script. */
  remote: boolean;
}

export type Handler = (ctx: CommandContext) => Promise<void> | void;

export interface Verb {
  summary: string;
  run: Handler;
}

export interface CommandGroup {
  description: string;
  verbs: Record<string, Verb>;
}

/**
 * Builds a stub handler for a command whose real implementation lands in a later phase. It prints a
 * clear notice and signals failure, so a not-yet-built command is never silently mistaken for a
 * successful no-op.
 */
export function notImplemented(phase: number): Handler {
  return () => {
    process.stderr.write(`not yet implemented (phase ${phase})\n`);
    process.exitCode = 1;
  };
}
