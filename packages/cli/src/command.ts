import type { ParseArgsOptionsConfig } from 'node:util';

/** Process exit codes. Documented in the package README; scripts depend on them. */
export const ExitCode = {
  Ok: 0,
  /** The command ran and found something: parse issues, changes under `--exit-code`, an evaluation error. */
  Findings: 1,
  /** The command could not run: bad arguments, an unreadable file, a file that is not JSON. */
  Usage: 2,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Everything a command touches outside its own arguments, so tests can run it in
 * memory. The `file` publish target is the exception: it writes to disk directly.
 */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  /** The only source of credentials. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** Runs git in the working directory and resolves with its stdout. Used by `lint --since-git`. */
  readonly git: (args: readonly string[]) => Promise<string>;
  /** Every file under `directory`, recursively, skipping `node_modules` and dot directories. */
  readonly listFiles: (directory: string) => Promise<string[]>;
}

export type OptionValue = string | boolean | (string | boolean)[] | undefined;

export interface CommandArgs {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, OptionValue>>;
}

/**
 * One subcommand. Registering it in `commands/registry.ts` is all it takes to
 * make it reachable and listed in `--help`.
 */
export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Printed under `kurenwimpel <name> --help`, after the generated usage line. */
  readonly usage: string;
  readonly options: ParseArgsOptionsConfig;
  readonly run: (args: CommandArgs, io: CliIo) => Promise<ExitCode>;
}

/** A mistake in how the command was called, or input it cannot read. Exits with {@link ExitCode.Usage}. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function stringOption(args: CommandArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanOption(args: CommandArgs, name: string): boolean {
  return args.values[name] === true;
}

/** Reads `--format`, rejecting anything outside `allowed`. The first entry is the default. */
export function formatOption<T extends string>(
  args: CommandArgs,
  allowed: readonly [T, ...T[]],
): T {
  const value = stringOption(args, 'format');
  if (value === undefined) return allowed[0];

  const match = allowed.find((format) => format === value);
  if (match === undefined) {
    throw new UsageError(`--format must be one of: ${allowed.join(', ')}`);
  }
  return match;
}

export const FORMAT_OPTION = { format: { type: 'string', short: 'f' } } as const;
