import { stringOption, UsageError } from '../command.js';
import type { CliIo, CommandArgs } from '../command.js';
import { loadConfig, resolveRuleset, resolveTarget } from '../config/load-config.js';
import type { LoadedConfig } from '../config/load-config.js';
import { DEFAULT_CONFIG_PATH } from '../config/types.js';
import { createTarget } from '../targets/create-target.js';
import type { PublishTarget } from '../targets/target.js';

export const CONFIG_OPTION = { config: { type: 'string', short: 'c' } } as const;

export const CONFIG_USAGE = `--config defaults to ./${DEFAULT_CONFIG_PATH}. Credentials come from environment variables only.`;

/**
 * The `<env>` positional followed by the `extra` ones, and at most the `optional`
 * ones after those.
 */
export function environmentArgument(
  args: CommandArgs,
  extra: readonly string[] = [],
  optional: readonly string[] = [],
): string[] {
  const required = ['<env>', ...extra];
  const count = args.positionals.length;
  if (count < required.length || count > required.length + optional.length) {
    const expected = [...required, ...optional.map((name) => `[${name}]`)];
    throw new UsageError(`expected ${expected.join(' ')}`);
  }
  return [...args.positionals];
}

export function readConfig(args: CommandArgs, io: CliIo): Promise<LoadedConfig> {
  return loadConfig(io, stringOption(args, 'config') ?? DEFAULT_CONFIG_PATH);
}

/** The ruleset file named on the command line, or else the one the config gives `environment`. */
export async function rulesetArgument(
  args: CommandArgs,
  io: CliIo,
  environment: string,
  file: string | undefined,
): Promise<string> {
  if (file !== undefined) return file;
  return resolveRuleset(await readConfig(args, io), environment);
}

/** Loads the config and builds the target `environment` publishes to. */
export async function openTarget(
  args: CommandArgs,
  io: CliIo,
  environment: string,
): Promise<PublishTarget> {
  return createTarget(resolveTarget(await readConfig(args, io), environment), io);
}
