import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig, revisionOf, run } from '../src/index.js';
import type { CliIo, EnvsReport, PublishReport } from '../src/index.js';
import { ExitCode } from './fixtures.js';
import type { CliOutcome, TestRuleset } from './fixtures.js';

/**
 * Runs the commands the example workflow runs, from the root of a copy of
 * `examples/gitops`, with every target swapped for a file under `out/`.
 */
const EXAMPLE = findUp(import.meta.dirname, 'examples/gitops');

/** Searched for upwards, so the test also finds it from a Stryker sandbox nested deeper. */
function findUp(from: string, path: string): string {
  const candidate = join(from, path);
  if (existsSync(candidate)) return candidate;
  const parent = dirname(from);
  if (parent === from) throw new Error(`no ${path} above ${import.meta.dirname}`);
  return findUp(parent, path);
}
const CONFIG = 'flags/kurenwimpel.config.json';

let root: string;
let original: string;
let minutes = 0;

async function cli(...argv: string[]): Promise<CliOutcome> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readFile: (path) => readFile(path, 'utf8'),
    env: {},
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, minutes++)),
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

async function exampleRuleset(environment: string): Promise<TestRuleset> {
  return JSON.parse(
    await readFile(join(EXAMPLE, 'flags', `${environment}.json`), 'utf8'),
  ) as TestRuleset;
}

async function write(path: string, ruleset: TestRuleset): Promise<void> {
  await writeFile(path, `${JSON.stringify(ruleset, null, 2)}\n`);
}

beforeAll(() => {
  original = process.cwd();
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kurenwimpel-gitops-'));
  await cp(EXAMPLE, root, { recursive: true });

  const config = JSON.parse(await readFile(join(root, CONFIG), 'utf8')) as {
    environments: Record<string, { target: unknown }>;
  };
  parseConfig(config, CONFIG);
  for (const [name, environment] of Object.entries(config.environments)) {
    environment.target = { type: 'file', path: `../out/${name}.json` };
  }
  await writeFile(join(root, CONFIG), JSON.stringify(config));
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(original);
  await rm(root, { recursive: true, force: true });
});

describe('the gitops example', () => {
  it('validates every environment', async () => {
    const { stdout } = await cli('envs', '-c', CONFIG, '-f', 'json');
    const rulesets = (JSON.parse(stdout) as EnvsReport).environments.map((env) => env.ruleset);

    expect(rulesets).toEqual([
      'flags/production.json',
      'flags/staging.json',
      'flags/development.json',
    ]);
    expect((await cli('validate', ...rulesets)).code).toBe(ExitCode.Ok);
  });

  it('lists every approver in its CODEOWNERS', async () => {
    const codeowners = (await readFile('.github/CODEOWNERS', 'utf8')).split('\n');
    const { stdout } = await cli('envs', '-c', CONFIG, '-f', 'codeowners');

    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(codeowners).toContain(line);
  });

  it('maps a changed ruleset to its environment', async () => {
    const { stdout } = await cli(
      'envs',
      '-c',
      CONFIG,
      '--changed',
      'flags/staging.json',
      'README.md',
    );
    expect(stdout).toBe('staging flags/staging.json @acme/flags-staging\n');
  });

  it('fails a broken ruleset with an annotation on the line of the flag', async () => {
    const ruleset = await exampleRuleset('production');
    ruleset.flags[0]!.defaultVariant = 'missing';
    await write('flags/production.json', ruleset);

    const { code, stdout } = await cli('validate', 'flags/production.json', '-f', 'github');

    expect(code).toBe(ExitCode.Findings);
    const text = await readFile('flags/production.json', 'utf8');
    const line = text.split('\n').indexOf('      "key": "new-checkout",') + 1;
    expect(stdout).toContain(
      `::error file=flags/production.json,line=${line},title=kurenwimpel%3A new-checkout::`,
    );
    expect((await cli('publish', 'production', '-c', CONFIG)).code).toBe(ExitCode.Findings);
  });

  it('says in the pull request comment that a change reshuffles a rollout', async () => {
    const ruleset = await exampleRuleset('staging');
    ruleset.flags[0]!.rules![1]!.rollout = [
      { variant: 'on', weight: 80 },
      { variant: 'off', weight: 50 },
    ];
    await write('flags/staging.json', ruleset);

    const { stdout } = await cli(
      'diff',
      join(EXAMPLE, 'flags/staging.json'),
      'flags/staging.json',
      '-f',
      'markdown',
    );

    expect(stdout).toContain('1 flag and 0 segments differ. 1 change reshuffles subjects.');
    expect(stdout).toContain('| **rollout-reshuffled** | `rules[recent-app].rollout` |');
  });

  it('publishes each environment, then rolls one back', async () => {
    const environments = ['production', 'staging', 'development'];
    const outcomes = await Promise.all(
      environments.map((env) => cli('publish', env, '-c', CONFIG)),
    );
    expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0, 0]);
    const first = revisionOf(await exampleRuleset('production'));
    expect(await readFile('out/production.json', 'utf8')).toBe(first.payload);

    const edited = await exampleRuleset('production');
    edited.flags[0]!.allocation = { percent: 30 };
    await write('flags/production.json', edited);
    const published = await cli('publish', 'production', '-c', CONFIG, '-f', 'json');
    expect(JSON.parse(published.stdout)).toMatchObject<Partial<PublishReport>>({
      status: 'published',
      previousRevision: first.revision,
    });

    const rollback = await cli('rollback', 'production', '-c', CONFIG, '--to', first.revision);
    expect(rollback.code).toBe(ExitCode.Ok);
    expect(await readFile('out/production.json', 'utf8')).toBe(first.payload);
    const revisions = await cli('revisions', 'production', '-c', CONFIG);
    expect(revisions.stdout).toMatch(new RegExp(`^\\* ${first.revision} `, 'mu'));
  });
});
