import { isAllocated } from '@kurenwimpel/core';
import { describe, expect, it } from 'vitest';

import type { EvalReport } from '../src/index.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';

/** A targeting key the README flag's 20% allocation admits, so its rules are reached. */
function admittedKey(prefix: string): string {
  for (let index = 0; ; index++) {
    const key = `${prefix}-${index}`;
    if (isAllocated({ percent: 20 }, 'new-checkout', key)) return key;
  }
}

async function evalJson(args: readonly string[], ruleset: unknown = readmeRuleset()) {
  const outcome = await runCli(['eval', 'flags.json', '-f', 'json', ...args], {
    'flags.json': ruleset,
  });
  return { ...outcome, report: JSON.parse(outcome.stdout) as EvalReport };
}

describe('kurenwimpel eval', () => {
  it('explains an individual target', async () => {
    const { code, report } = await evalJson([
      '--flag',
      'new-checkout',
      '--context',
      '{"targetingKey":"qa-account-1"}',
    ]);
    expect(code).toBe(ExitCode.Ok);
    expect(report.context).toEqual({ targetingKey: 'qa-account-1' });
    expect(report.results).toEqual([
      expect.objectContaining({
        key: 'new-checkout',
        value: true,
        variant: 'on',
        reason: 'TARGETING_MATCH',
        prerequisites: [
          {
            flag: 'new-backend',
            requiredVariants: ['on'],
            status: 'satisfied',
            variant: 'on',
            reason: 'STATIC',
          },
        ],
      }),
    ]);
  });

  it('names the rule that decided', async () => {
    const context = JSON.stringify({ targetingKey: admittedKey('staff'), email: 'a@example.com' });
    const { report } = await evalJson(['--flag', 'new-checkout', '--context', context]);
    expect(report.results[0]).toMatchObject({
      reason: 'TARGETING_MATCH',
      ruleId: 'internal-staff',
    });
  });

  it('reports a failed prerequisite and its outcome', async () => {
    const ruleset = readmeRuleset();
    ruleset.flags[1]!.enabled = false;
    const { report } = await evalJson(
      ['--flag', 'new-checkout', '--context', '{"targetingKey":"u"}'],
      ruleset,
    );
    expect(report.results[0]).toMatchObject({
      variant: 'off',
      reason: 'PREREQUISITE_FAILED',
      failedPrerequisite: 'new-backend',
      prerequisites: [
        { flag: 'new-backend', status: 'failed', variant: 'off', reason: 'DISABLED' },
      ],
    });
  });

  it('marks a prerequisite the evaluator never reached, and one that is missing', async () => {
    const ruleset = readmeRuleset();
    ruleset.flags[0]!.enabled = false;
    ruleset.flags[0]!.prerequisites!.push({ flag: 'ghost', variants: ['on'] });
    const { report } = await evalJson(['--flag', 'new-checkout'], ruleset);
    expect(report.results[0]?.prerequisites.map((outcome) => outcome.status)).toEqual([
      'not-evaluated',
      'missing',
    ]);
  });

  it('evaluates every flag under --all', async () => {
    const { code, report } = await evalJson([
      '--all',
      '--context',
      '{"targetingKey":"qa-account-1"}',
    ]);
    expect(code).toBe(ExitCode.Ok);
    expect(report.results.map((result) => result.key)).toEqual(['new-checkout', 'new-backend']);
  });

  it('prints a readable explanation', async () => {
    const context = JSON.stringify({ targetingKey: admittedKey('user'), appVersion: '2.4.1' });
    const { stdout } = await runCli(
      ['eval', 'flags.json', '--flag', 'new-checkout', '--context', context],
      { 'flags.json': readmeRuleset() },
    );
    expect(stdout).toMatch(
      /^new-checkout = (true|false) \(variant (on|off)\)\n {2}reason: SPLIT\n/u,
    );
    expect(stdout).toContain('  rule: recent-app\n');
    expect(stdout).toContain('    new-backend: satisfied (needs on; serving on, STATIC)');
  });

  it('exits 1 when a flag does not resolve', async () => {
    const { code, report } = await evalJson(['--flag', 'nope']);
    expect(code).toBe(ExitCode.Findings);
    expect(report.results[0]).toMatchObject({ reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' });

    const text = await runCli(['eval', 'f.json', '--flag', 'nope'], { 'f.json': readmeRuleset() });
    expect(text.stdout).toContain('nope: no value\n  reason: ERROR\n  error: FLAG_NOT_FOUND');
  });

  it.each([
    [['--flag', 'new-checkout', '--all'], 'pass exactly one of'],
    [[], 'pass exactly one of'],
    [['--all', '--context', '[1]'], '--context must be a JSON object'],
    [['--all', '--context', '{'], '--context is not valid JSON'],
  ])('exits 2 on %j', async (args, message) => {
    const { code, stderr } = await runCli(['eval', 'f.json', ...args], {
      'f.json': readmeRuleset(),
    });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(message);
  });
});
