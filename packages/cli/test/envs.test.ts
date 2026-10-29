import { describe, expect, it } from 'vitest';

import type { EnvsReport } from '../src/index.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';

const CONFIG = 'flags/kurenwimpel.config.json';
const target = { type: 'file', path: 'out.json' };
const files = {
  [CONFIG]: {
    environments: {
      production: { target, approvers: ['@acme/flags-production', 'ops@acme.test'] },
      staging: { target, ruleset: 'stage.json' },
      development: { target },
    },
  },
};

function envs(...argv: string[]) {
  return runCli(['envs', '--config', CONFIG, ...argv], files);
}

function names(stdout: string): string[] {
  return (JSON.parse(stdout) as EnvsReport).environments.map((environment) => environment.name);
}

describe('kurenwimpel envs', () => {
  it('lists every environment with its ruleset and approvers', async () => {
    const { code, stdout } = await envs('--format', 'json');

    expect(code).toBe(ExitCode.Ok);
    expect(JSON.parse(stdout)).toEqual({
      environments: [
        {
          name: 'production',
          ruleset: 'flags/production.json',
          approvers: ['@acme/flags-production', 'ops@acme.test'],
        },
        { name: 'staging', ruleset: 'flags/stage.json', approvers: [] },
        { name: 'development', ruleset: 'flags/development.json', approvers: [] },
      ],
    });
  });

  it('prints one line per environment as text', async () => {
    const { stdout } = await envs();
    expect(stdout).toBe(
      [
        'production flags/production.json @acme/flags-production ops@acme.test',
        'staging flags/stage.json',
        'development flags/development.json',
        '',
      ].join('\n'),
    );
  });

  it('keeps only the environments whose ruleset changed', async () => {
    const changed = await envs('-f', 'json', '--changed', 'flags/stage.json', './README.md');
    expect(names(changed.stdout)).toEqual(['staging']);

    const nothing = await envs('-f', 'json', '--changed');
    expect(names(nothing.stdout)).toEqual([]);
  });

  it('treats a change to the config as a change to every environment', async () => {
    const { stdout } = await envs('-f', 'json', '--changed', CONFIG);
    expect(names(stdout)).toEqual(['production', 'staging', 'development']);
  });

  it('prints CODEOWNERS lines for the environments with approvers', async () => {
    const { stdout } = await envs('--format', 'codeowners');
    expect(stdout).toBe('/flags/production.json @acme/flags-production ops@acme.test\n');
  });

  it('refuses a CODEOWNERS path outside the working directory', async () => {
    const outside = { environments: { prod: { target, approvers: ['@a'] } } };
    const { code, stderr } = await runCli(['envs', '-c', '../k.json', '-f', 'codeowners'], {
      '../k.json': outside,
    });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('../prod.json is outside the working directory');
  });

  it('exits 2 on files without --changed', async () => {
    const { code, stderr } = await envs('flags/stage.json');
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('files are only accepted after --changed');
  });
});

describe('kurenwimpel publish without a file', () => {
  it("publishes the environment's configured ruleset", async () => {
    const { code, stderr } = await runCli(['publish', 'staging'], {
      'kurenwimpel.config.json': { environments: { staging: { target, ruleset: 'stage.json' } } },
      'stage.json': { ...readmeRuleset(), flags: 'broken' },
    });

    expect(code).toBe(ExitCode.Findings);
    expect(stderr).toContain('refusing to publish stage.json');
  });
});
