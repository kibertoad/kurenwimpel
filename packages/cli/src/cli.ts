import { parseArgs } from 'node:util';

import { ExitCode } from './command.js';
import type { CliIo, Command } from './command.js';
import { COMMANDS } from './commands/registry.js';
import { messageOf } from './ruleset-file.js';

const HELP_OPTION = { help: { type: 'boolean', short: 'h' } } as const;

/**
 * Runs one CLI invocation and returns its exit code. Never throws: every
 * failure is printed to `io.stderr` and mapped to an {@link ExitCode}.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  commands: readonly Command[] = COMMANDS,
): Promise<ExitCode> {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    io.stdout(overview(commands));
    return name === undefined ? ExitCode.Usage : ExitCode.Ok;
  }

  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    io.stderr(`Unknown command "${name}".\n\n${overview(commands)}`);
    return ExitCode.Usage;
  }

  try {
    const { positionals, values } = parseArgs({
      args: [...rest],
      options: { ...command.options, ...HELP_OPTION },
      allowPositionals: true,
      strict: true,
    });

    if (values['help'] === true) {
      io.stdout(commandHelp(command));
      return ExitCode.Ok;
    }

    return await command.run({ positionals, values }, io);
  } catch (error) {
    io.stderr(`kurenwimpel ${command.name}: ${messageOf(error)}\n`);
    if (isArgumentError(error)) io.stderr(`\n${commandHelp(command)}`);
    return ExitCode.Usage;
  }
}

/** `parseArgs` reports bad flags as a TypeError carrying an `ERR_PARSE_ARGS_*` code. */
function isArgumentError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
}

function overview(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);
  return [
    'Usage: kurenwimpel <command> [options]',
    '',
    'Commands:',
    ...lines,
    '',
    'Run `kurenwimpel <command> --help` for the options of one command.',
    '',
  ].join('\n');
}

function commandHelp(command: Command): string {
  return `${command.summary}\n\n${command.usage.trimEnd()}\n`;
}
