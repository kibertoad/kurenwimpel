import { stringOption, UsageError } from '../command.js';
import type { CliIo, CommandArgs } from '../command.js';
import { loadConfig, resolveTarget } from '../config/load-config.js';
import { DEFAULT_CONFIG_PATH } from '../config/types.js';
import { createTarget } from '../targets/create-target.js';
import type { PublishTarget } from '../targets/target.js';

export const CONFIG_OPTION = { config: { type: 'string', short: 'c' } } as const;

export const CONFIG_USAGE = `--config defaults to ./${DEFAULT_CONFIG_PATH}. Credentials come from environment variables only.`;

/** The `<env>` positional, which must be the first and, with `extra` more, the only ones. */
export function environmentArgument(args: CommandArgs, extra: readonly string[] = []): string[] {
  const expected = ['<env>', ...extra];
  if (args.positionals.length !== expected.length) {
    throw new UsageError(`expected ${expected.join(' ')}`);
  }
  return [...args.positionals];
}

/** Loads the config and builds the target `environment` publishes to. */
export async function openTarget(
  args: CommandArgs,
  io: CliIo,
  environment: string,
): Promise<PublishTarget> {
  const loaded = await loadConfig(io, stringOption(args, 'config') ?? DEFAULT_CONFIG_PATH);
  return createTarget(resolveTarget(loaded, environment), io);
}
