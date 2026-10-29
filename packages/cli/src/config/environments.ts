import { isAbsolute, relative, resolve, sep } from 'node:path';

import { UsageError } from '../command.js';
import { resolveRuleset, resolveSchedule } from './load-config.js';
import type { LoadedConfig } from './load-config.js';

export interface EnvironmentSummary {
  readonly name: string;
  /** Relative to the working directory, with `/` separators. */
  readonly ruleset: string;
  /** The same, for the schedule file, which need not exist. */
  readonly schedule: string;
  readonly approvers: readonly string[];
}

/** Every configured environment, in config order. */
export function listEnvironments(loaded: LoadedConfig): EnvironmentSummary[] {
  return Object.entries(loaded.config.environments).map(([name, entry]) => ({
    name,
    ruleset: fromWorkingDirectory(resolveRuleset(loaded, name)),
    schedule: fromWorkingDirectory(resolveSchedule(loaded, name)),
    approvers: entry.approvers ?? [],
  }));
}

/** The files whose content decides what an environment serves, now or later. */
function filesOf(environment: EnvironmentSummary): string[] {
  return [environment.ruleset, environment.schedule];
}

/**
 * The environments a change to `files` touches. A change to the config itself
 * touches every one, since it may move any of them to another target.
 */
export function changedEnvironments(
  loaded: LoadedConfig,
  files: readonly string[],
): EnvironmentSummary[] {
  const environments = listEnvironments(loaded);
  const changed = new Set(files.map((file) => fromWorkingDirectory(file)));
  if (changed.has(fromWorkingDirectory(loaded.path))) return environments;
  return environments.filter((environment) =>
    filesOf(environment).some((file) => changed.has(file)),
  );
}

/**
 * CODEOWNERS lines for the files of each environment that names approvers,
 * anchored at the repository root. The schedule gets the same owners as the
 * ruleset, since an entry in it changes the environment just as an edit does.
 */
export function codeownersLines(environments: readonly EnvironmentSummary[]): string[] {
  return environments
    .filter((environment) => environment.approvers.length > 0)
    .flatMap((environment) =>
      filesOf(environment).map((path) => codeownersLine(path, environment.approvers)),
    );
}

function codeownersLine(path: string, approvers: readonly string[]): string {
  if (path.startsWith('../') || isAbsolute(path)) {
    throw new UsageError(`${path} is outside the working directory; run from the repository root`);
  }
  return `/${path.replaceAll(' ', String.raw`\ `)} ${approvers.join(' ')}`;
}

function fromWorkingDirectory(path: string): string {
  return relative(process.cwd(), resolve(path)).split(sep).join('/');
}
