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
 * Returns `value` or throws if it is undefined — for a required `--flag` after `parseArgs`, which types
 * every option as optional. `name` is the flag as the operator typed it (without the leading `--`).
 */
export function requireFlag(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Missing required --${name}.`);
  return value;
}

/**
 * Parses `raw` as a positive integer (a record or key id, or a positive count), or throws. `name` is the
 * flag as the operator typed it (without the leading `--`). The result is safe to interpolate into SQL
 * bare — it is a validated integer, not free-form text.
 */
export function requirePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --${name}: ${JSON.stringify(raw)}. Must be a positive integer.`);
  }
  return n;
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
