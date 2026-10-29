import { isAbsolute, relative, resolve, sep } from 'node:path';

import { UsageError } from '../command.js';
import { resolveRuleset } from './load-config.js';
import type { LoadedConfig } from './load-config.js';

export interface EnvironmentSummary {
  readonly name: string;
  /** Relative to the working directory, with `/` separators. */
  readonly ruleset: string;
  readonly approvers: readonly string[];
}

/** Every configured environment, in config order. */
export function listEnvironments(loaded: LoadedConfig): EnvironmentSummary[] {
  return Object.entries(loaded.config.environments).map(([name, entry]) => ({
    name,
    ruleset: fromWorkingDirectory(resolveRuleset(loaded, name)),
    approvers: entry.approvers ?? [],
  }));
}

/** The files whose content decides what an environment serves. */
function filesOf(environment: EnvironmentSummary): string[] {
  return [environment.ruleset];
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

/** One CODEOWNERS line per environment that names approvers, anchored at the repository root. */
export function codeownersLines(environments: readonly EnvironmentSummary[]): string[] {
  return environments
    .filter((environment) => environment.approvers.length > 0)
    .map((environment) => {
      const path = environment.ruleset;
      if (path.startsWith('../') || isAbsolute(path)) {
        throw new UsageError(
          `${path} is outside the working directory; run from the repository root`,
        );
      }
      return `/${path.replaceAll(' ', String.raw`\ `)} ${environment.approvers.join(' ')}`;
    });
}

function fromWorkingDirectory(path: string): string {
  return relative(process.cwd(), resolve(path)).split(sep).join('/');
}
