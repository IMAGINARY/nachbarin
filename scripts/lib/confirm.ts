/**
 * Typed-confirmation prompt for destructive operations against `--remote`.
 *
 * Destructive commands (installation delete, key revoke, record erase) make the operator retype a value
 * that identifies the target — the installation pair, a label — so a fat-fingered `--remote` cannot
 * quietly destroy the wrong thing. The comparison is a pure function ({@link matchesConfirmation}) so it
 * is testable; the readline part is a thin wrapper around it.
 */

import { createInterface } from 'node:readline/promises';

/**
 * True when the operator's typed input exactly matches what was required. Surrounding whitespace from the
 * terminal is trimmed; nothing else is normalized — the match is deliberately exact.
 */
export function matchesConfirmation(input: string, expected: string): boolean {
  return input.trim() === expected;
}

/**
 * Prompts on stdin for the operator to retype `expected`, resolving true only on an exact match.
 * `promptText` should say what to type and why. Reads a single line and closes the interface.
 */
export async function confirmTyped(expected: string, promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(promptText);
    return matchesConfirmation(answer, expected);
  } finally {
    rl.close();
  }
}
