import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { revisionOf } from '../src/index.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';
import type { CliOutcome } from './fixtures.js';

let directory: string;
let minutes: number;

beforeEach(async () => {
  minutes = 0;
  directory = await mkdtemp(join(tmpdir(), 'kurenwimpel-publish-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function edition(enabled: boolean): unknown {
  const ruleset = readmeRuleset();
  ruleset.flags[1]!.enabled = enabled;
  return ruleset;
}

/** The config sits in `directory`; its relative target path resolves against it. */
function cli(...argv: string[]): Promise<CliOutcome> {
  const configPath = join(directory, 'kurenwimpel.config.json');
  const files = {
    [configPath]: { environments: { local: { target: { type: 'file', path: 'out/flags.json' } } } },
    'a.json': edition(true),
    'b.json': edition(false),
  };
  return runCli([...argv, '--config', configPath], files, {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, minutes++)),
  });
}

describe('kurenwimpel publish to a file', () => {
  it('writes the canonical JSON and leaves no temp file behind', async () => {
    const { code } = await cli('publish', 'local', 'a.json');

    expect(code).toBe(ExitCode.Ok);
    const target = join(directory, 'out', 'flags.json');
    expect(await readFile(target, 'utf8')).toBe(revisionOf(edition(true)).payload);
    expect(await readdir(join(directory, 'out'))).toEqual(['flags.json', 'flags.json.revisions']);
  });

  it('recognises the file it wrote and writes nothing the second time', async () => {
    await cli('publish', 'local', 'a.json');

    const { stdout } = await cli('publish', 'local', 'a.json');

    expect(stdout).toBe(
      `local: file ${join(directory, 'out', 'flags.json')} already serves ${revisionOf(edition(true)).revision}; nothing written\n`,
    );
  });

  it('rolls back to the previous revision and lists both', async () => {
    await cli('publish', 'local', 'a.json');
    await cli('publish', 'local', 'b.json');
    const a = revisionOf(edition(true));

    const rollback = await cli('rollback', 'local');
    const revisions = await cli('revisions', 'local', '--format', 'json');

    expect(rollback.code).toBe(ExitCode.Ok);
    expect(await readFile(join(directory, 'out', 'flags.json'), 'utf8')).toBe(a.payload);
    expect(JSON.parse(revisions.stdout)).toMatchObject({
      environment: 'local',
      revisions: [{ current: false }, { revision: a.revision, current: true }],
    });
  });

  it('reports an empty history', async () => {
    const { code, stdout } = await cli('revisions', 'local');

    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('local: no revisions stored\n');
  });
});
