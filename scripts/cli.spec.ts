import { describe, expect, it } from 'vitest';
import { commands, helpText, parseInvocation, resolve } from './cli.ts';

describe('parseInvocation', () => {
  it('extracts noun, verb, and the command remainder', () => {
    const inv = parseInvocation(['key', 'mint', '--app', 'foo']);
    expect(inv.noun).toBe('key');
    expect(inv.verb).toBe('mint');
    expect(inv.rest).toEqual(['--app', 'foo']);
    expect(inv.remote).toBe(false);
  });

  it('recognizes --remote/--local anywhere and defaults to local', () => {
    expect(parseInvocation(['key', 'mint']).remote).toBe(false);
    expect(parseInvocation(['--remote', 'key', 'mint']).remote).toBe(true);
    expect(parseInvocation(['key', 'mint', '--remote']).remote).toBe(true);
    // Last one wins: an explicit --local after --remote returns to local.
    expect(parseInvocation(['--remote', '--local', 'key', 'mint']).remote).toBe(false);
  });

  it('flags --help and -h', () => {
    expect(parseInvocation(['--help']).help).toBe(true);
    expect(parseInvocation(['-h']).help).toBe(true);
    expect(parseInvocation(['key', 'mint']).help).toBe(false);
  });
});

describe('resolve', () => {
  it('resolves a known noun/verb to a handler', () => {
    const r = resolve('key', 'mint');
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.noun).toBe('key');
      expect(r.verb).toBe('mint');
      expect(typeof r.run).toBe('function');
    }
  });

  it('errors on an unknown noun', () => {
    const r = resolve('nope', 'mint');
    expect('error' in r && r.error).toMatch(/Unknown command/);
  });

  it('errors on an unknown verb', () => {
    const r = resolve('key', 'frobnicate');
    expect('error' in r && r.error).toMatch(/Unknown key subcommand/);
  });
});

describe('helpText', () => {
  it('lists every command and subcommand', () => {
    const help = helpText();
    for (const [noun, group] of Object.entries(commands)) {
      expect(help).toContain(noun);
      for (const verb of Object.keys(group.verbs)) {
        expect(help).toContain(verb);
      }
    }
  });
});
