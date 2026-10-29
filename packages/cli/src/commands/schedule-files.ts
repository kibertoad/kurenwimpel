import type { CliIo, CommandArgs } from '../command.js';
import { resolveRuleset, resolveSchedule } from '../config/load-config.js';
import { messageOf, parseJson, readText, readTextIfPresent } from '../ruleset-file.js';
import { parseSchedule } from '../schedule/schedule-file.js';
import type { ParsedSchedule } from '../schedule/schedule-file.js';
import { environmentArgument, readConfig } from './environment.js';

/** An environment's ruleset document and schedule, as read from the repository. */
export interface EnvironmentSchedule {
  readonly environment: string;
  readonly rulesetPath: string;
  readonly schedulePath: string;
  readonly document: unknown;
  /** The schedule file as read, empty when there is none. */
  readonly text: string;
  readonly schedule: ParsedSchedule;
}

export async function loadEnvironmentSchedule(
  args: CommandArgs,
  io: CliIo,
): Promise<EnvironmentSchedule> {
  const [environment = ''] = environmentArgument(args);
  const config = await readConfig(args, io);
  const rulesetPath = resolveRuleset(config, environment);
  const schedulePath = resolveSchedule(config, environment);

  const document = parseJson(await readText(io, rulesetPath), rulesetPath);
  const text = (await readTextIfPresent(io, schedulePath)) ?? '';
  return { environment, rulesetPath, schedulePath, document, text, schedule: readSchedule(text) };
}

function readSchedule(text: string): ParsedSchedule {
  if (text === '') return parseSchedule([]);
  try {
    return parseSchedule(JSON.parse(text));
  } catch (error) {
    return { entries: [], issues: [{ entry: '$', message: messageOf(error) }], raw: [] };
  }
}

/** Forward slashes, so a report reads the same on every platform. */
export function displayPath(path: string): string {
  return path.replaceAll('\\', '/');
}
