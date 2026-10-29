import { describe, expect, it } from 'vitest';

import type { DiffReport, ValidateReport } from '../src/index.js';
import { checkout, ExitCode, readmeRuleset, runCli } from './fixtures.js';

describe('kurenwimpel', () => {
  it('lists the commands under --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toMatch(/validate\s+Parse ruleset files/u);
    expect(stdout).toMatch(/diff\s+/u);
    expect(stdout).toMatch(/eval\s+/u);
  });

  it('exits 2 with no command or an unknown one', async () => {
    expect((await runCli([])).code).toBe(ExitCode.Usage);
    const unknown = await runCli(['publish']);
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.stderr).toContain('Unknown command "publish"');
  });

  it('prints one command help', async () => {
    const { code, stdout } = await runCli(['diff', '--help']);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain('Usage: kurenwimpel diff <old> <new>');
  });

  it('exits 2 on an unknown option or format', async () => {
    const option = await runCli(['validate', 'a.json', '--strict']);
    expect(option.code).toBe(ExitCode.Usage);
    expect(option.stderr).toContain('Usage: kurenwimpel validate');

    const format = await runCli(['validate', 'a.json', '--format', 'yaml']);
    expect(format.code).toBe(ExitCode.Usage);
    expect(format.stderr).toContain('--format must be one of: text, json');
  });
});

describe('kurenwimpel validate', () => {
  it('passes the README example', async () => {
    const { code, stdout } = await runCli(['validate', 'flags.json'], {
      'flags.json': readmeRuleset(),
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('flags.json: ok (2 flags, 1 segment)\n');
  });

  it('prints every issue with its path and exits 1', async () => {
    const broken = readmeRuleset();
    broken.flags[0]!.defaultVariant = 'missing';
    broken.schemaVersion = 99;

    const { code, stdout } = await runCli(['validate', 'good.json', 'bad.json'], {
      'good.json': readmeRuleset(),
      'bad.json': broken,
    });
    expect(code).toBe(ExitCode.Findings);
    expect(stdout).toContain('good.json: ok');
    expect(stdout).toContain('bad.json: 2 issues (1 flag, 1 segment loaded)');
    expect(stdout).toContain('  schemaVersion: schemaVersion 99 is newer than 1');
    expect(stdout).toContain('  new-checkout: ');
  });

  it('reports invalid JSON as an issue', async () => {
    const { code, stdout } = await runCli(['validate', '--format', 'json', 'x.json'], {
      'x.json': '{ "flags": [',
    });
    expect(code).toBe(ExitCode.Findings);
    const report = JSON.parse(stdout) as ValidateReport;
    expect(report.valid).toBe(false);
    expect(report.files[0]).toMatchObject({ path: 'x.json', flags: 0, issues: [{ at: '$' }] });
  });

  it('reads a file that starts with a byte order mark', async () => {
    const { code } = await runCli(['validate', 'bom.json'], {
      'bom.json': `﻿${JSON.stringify(readmeRuleset())}`,
    });
    expect(code).toBe(ExitCode.Ok);
  });

  it('prints the documented JSON shape', async () => {
    const { stdout } = await runCli(['validate', '-f', 'json', 'flags.json'], {
      'flags.json': readmeRuleset(),
    });
    expect(JSON.parse(stdout)).toEqual({
      valid: true,
      files: [{ path: 'flags.json', flags: 2, segments: 1, issues: [] }],
    });
  });

  it('exits 2 on a file it cannot read, and with no file at all', async () => {
    const missing = await runCli(['validate', 'nope.json']);
    expect(missing.code).toBe(ExitCode.Usage);
    expect(missing.stderr).toContain('cannot read nope.json');
    expect((await runCli(['validate'])).code).toBe(ExitCode.Usage);
  });
});

/** A widened allocation, a reshuffling reweight and a new segment key. */
function files(): Record<string, unknown> {
  const after = readmeRuleset();
  const { flag, rules } = checkout(after);
  flag.allocation = { percent: 50 };
  rules[1]!.rollout = [
    { variant: 'on', weight: 80 },
    { variant: 'off', weight: 50 },
  ];
  after.segments[0]!.included = ['emp-1', 'emp-2', 'emp-3'];
  return { 'old.json': readmeRuleset(), 'new.json': after };
}

describe('kurenwimpel diff', () => {
  it('prints a text diff and exits 0', async () => {
    const { code, stdout } = await runCli(['diff', 'old.json', 'new.json'], files());
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain('flag new-checkout: changed');
    expect(stdout).toContain('  ~ allocation.percent: allocation 20% to 50%');
    expect(stdout).toContain(
      '  ! rules[recent-app].rollout: weights on 50 / off 50 to on 80 / off 50',
    );
    expect(stdout).toContain('segment employees: changed (used by new-checkout)');
    expect(stdout).toContain('1 flag and 1 segment differ. 1 change reshuffles subjects.');
  });

  it('prints Markdown for a pull request comment', async () => {
    const { stdout } = await runCli(['diff', 'old.json', 'new.json', '-f', 'markdown'], files());
    expect(stdout).toContain('### Ruleset diff');
    expect(stdout).toContain('#### flag `new-checkout`: changed');
    expect(stdout).toContain('| **rollout-reshuffled** | `rules[recent-app].rollout` |');
    expect(stdout).toContain('| allocation-widened | `allocation.percent` |');
  });

  it('prints the documented JSON shape', async () => {
    const { stdout } = await runCli(['diff', 'old.json', 'new.json', '-f', 'json'], files());
    const report = JSON.parse(stdout) as DiffReport;
    expect(Object.keys(report)).toEqual([
      'old',
      'new',
      'issues',
      'flags',
      'segments',
      'reshuffles',
    ]);
    expect(report.reshuffles).toBe(true);
    expect(report.issues).toEqual({ old: [], new: [] });
    expect(report.flags[0]?.changes[0]).toEqual({
      kind: 'allocation-widened',
      at: 'allocation.percent',
      from: 20,
      to: 50,
      reshuffles: false,
      summary: expect.any(String),
    });
  });

  it('exits 1 under --exit-code only when something changed', async () => {
    expect((await runCli(['diff', 'old.json', 'new.json', '--exit-code'], files())).code).toBe(
      ExitCode.Findings,
    );
    const same = { 'a.json': readmeRuleset(), 'b.json': readmeRuleset() };
    const unchanged = await runCli(['diff', 'a.json', 'b.json', '--exit-code'], same);
    expect(unchanged.code).toBe(ExitCode.Ok);
    expect(unchanged.stdout).toBe('No changes.\n');
  });

  it('warns about parse issues on either side', async () => {
    const broken = readmeRuleset();
    broken.flags[1]!.offVariant = 'missing';
    const { code, stderr } = await runCli(['diff', 'old.json', 'new.json'], {
      'old.json': readmeRuleset(),
      'new.json': broken,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain('warning: new.json: new-backend:');
  });

  it('exits 2 without two files, or on a file that is not JSON', async () => {
    expect((await runCli(['diff', 'old.json'], files())).code).toBe(ExitCode.Usage);
    const notJson = await runCli(['diff', 'old.json', 'x.json'], { ...files(), 'x.json': '{' });
    expect(notJson.code).toBe(ExitCode.Usage);
    expect(notJson.stderr).toContain('x.json is not valid JSON');
  });
});
