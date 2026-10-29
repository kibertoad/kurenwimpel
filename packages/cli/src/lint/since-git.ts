import { parseRuleset } from '@kurenwimpel/core';

import { UsageError } from '../command.js';
import type { CliIo } from '../command.js';
import { messageOf } from '../ruleset-file.js';

interface Commit {
  readonly sha: string;
  /** Committer date, ISO 8601. */
  readonly date: string;
}

/**
 * When each of `keys` was switched off, read from the history of `path`: the
 * date of the oldest commit in the unbroken run of commits, newest first, that
 * has the flag disabled. A key missing from the result has no committed
 * revision with it disabled yet.
 */
export async function switchedOffSince(
  io: CliIo,
  path: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const since = new Map<string, string>();
  if (keys.length === 0) return since;

  const tracked = (await git(io, ['ls-files', '--full-name', '--', path])).trim();
  if (tracked === '') return since;

  const open = new Set(keys);
  for (const commit of await history(io, path)) {
    // Sequential on purpose: the walk stops at the first revision where every
    // flag was still on, which is usually a few commits back.
    // oxlint-disable-next-line no-await-in-loop
    const enabled = await enabledAt(io, commit.sha, tracked);
    for (const key of open) {
      if (enabled.get(key) === false) since.set(key, commit.date);
      else open.delete(key);
    }
    if (open.size === 0) break;
  }
  return since;
}

async function history(io: CliIo, path: string): Promise<Commit[]> {
  const log = await git(io, ['log', '--format=%H %cI', '--', path]);
  return log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = '', date = ''] = line.split(' ');
      return { sha, date };
    });
}

/** Each flag's `enabled` at one commit. A revision that does not parse knows no flags. */
async function enabledAt(io: CliIo, sha: string, path: string): Promise<Map<string, boolean>> {
  const text = await git(io, ['show', `${sha}:${path}`]);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Map();
  }
  return new Map(parseRuleset(raw).flags.map((flag) => [flag.key, flag.enabled]));
}

async function git(io: CliIo, args: readonly string[]): Promise<string> {
  try {
    return await io.git(args);
  } catch (error) {
    throw new UsageError(`--since-git: ${messageOf(error)}`);
  }
}
