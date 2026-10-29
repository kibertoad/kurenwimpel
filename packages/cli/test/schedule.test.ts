import { describe, expect, it } from 'vitest';

import { parseSchedule, patchDocument } from '../src/index.js';
import type { ScheduleApplyReport, ScheduleReport } from '../src/index.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';
import type { TestRuleset } from './fixtures.js';

const CONFIG = 'kurenwimpel.config.json';
const RULESET = 'production.json';
const SCHEDULE = 'production.schedule.json';

const ramp = {
  id: 'checkout-ramp-50',
  at: '2026-11-03T09:00:00Z',
  flag: 'new-checkout',
  set: { allocation: { percent: 50 } },
};
const full = {
  id: 'checkout-full',
  at: '2026-11-10T09:00:00+01:00',
  flag: 'new-checkout',
  set: { allocation: null },
};

function files(entries: unknown, ruleset: unknown = readmeRuleset()) {
  return {
    [CONFIG]: { environments: { production: { target: { type: 'file', path: 'out.json' } } } },
    [RULESET]: ruleset,
    ...(entries === undefined ? {} : { [SCHEDULE]: entries }),
  };
}

function runSchedule(action: string, entries: unknown, ...argv: string[]) {
  return runCli(['schedule', action, 'production', ...argv], files(entries));
}

describe('kurenwimpel schedule validate', () => {
  it('applies every entry in time order and reports what each does', async () => {
    const { code, stdout } = await runSchedule('validate', [full, ramp], '-f', 'json');

    expect(code).toBe(ExitCode.Ok);
    const report = JSON.parse(stdout) as ScheduleReport;
    expect(report.valid).toBe(true);
    expect(report.entries.map((entry) => entry.id)).toEqual(['checkout-ramp-50', 'checkout-full']);
    const kinds = report.entries.flatMap((entry) => entry.changes).map((change) => change.kind);
    expect(kinds).toEqual(['allocation-widened', 'allocation-widened']);
  });

  it('fails an entry whose patch breaks the flag, with an annotation on its id', async () => {
    const broken = { ...ramp, set: { defaultVariant: 'missing' } };
    const text = `[\n  ${JSON.stringify(full)},\n  ${JSON.stringify(broken)}\n]\n`;

    const { code, stdout } = await runCli(
      ['schedule', 'validate', 'production', '-f', 'github'],
      files(text),
    );

    expect(code).toBe(ExitCode.Findings);
    expect(stdout).toMatch(
      /^::error file=production\.schedule\.json,line=3,title=kurenwimpel schedule%3A checkout-ramp-50::new-checkout: /u,
    );
  });

  it('fails an entry for a flag the ruleset does not have', async () => {
    const { code, stdout } = await runSchedule('validate', [{ ...ramp, flag: 'nope' }]);
    expect(code).toBe(ExitCode.Findings);
    expect(stdout).toContain('issue: nope: flag nope is not in the ruleset');
  });

  it('reports malformed entries and duplicate ids', async () => {
    const entries = [ramp, ramp, { ...full, at: '2026-11-10 09:00' }, { ...full, id: 'x', key: 1 }];
    const { code, stdout } = await runSchedule('validate', entries, '-f', 'json');

    expect(code).toBe(ExitCode.Findings);
    expect((JSON.parse(stdout) as ScheduleReport).issues).toEqual([
      { entry: '[1]', message: 'id checkout-ramp-50 is already used' },
      { entry: 'checkout-full', message: expect.stringContaining('at must be a date and time') },
      { entry: 'x', message: 'key is not a known field (expected id, at, flag, set)' },
    ]);
  });

  it('prints a pull request comment section, or nothing without a schedule', async () => {
    const pending = await runSchedule('validate', [ramp], '-f', 'markdown');
    expect(pending.stdout).toContain('`production.schedule.json`: 1 pending entry, no issues.');
    expect(pending.stdout).toContain(
      '| `2026-11-03T09:00:00Z` | `checkout-ramp-50` | `new-checkout` | allocation 20% to 50%',
    );

    const none = await runSchedule('validate', undefined, '-f', 'markdown');
    expect(none).toMatchObject({ code: ExitCode.Ok, stdout: '' });
  });

  it('exits 2 on --now, a missing action or a ruleset that is not there', async () => {
    expect((await runSchedule('validate', [], '--now', '2026-01-01T00:00:00Z')).code).toBe(2);
    expect((await runCli(['schedule', 'production'], files([]))).code).toBe(2);
    const missing = await runCli(['schedule', 'validate', 'production'], {
      [CONFIG]: files([])[CONFIG],
    });
    expect(missing.code).toBe(ExitCode.Usage);
  });
});

describe('kurenwimpel schedule apply', () => {
  it('applies the due entry, removes it, and keeps the rest', async () => {
    const { code, stdout, written } = await runSchedule(
      'apply',
      [full, ramp],
      '--now',
      '2026-11-03T09:00:00Z',
    );

    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('production: applied checkout-ramp-50; 1 entry pending\n');
    const ruleset = JSON.parse(written[RULESET]!) as TestRuleset;
    expect(ruleset.flags[0]!.allocation).toEqual({ percent: 50 });
    expect(JSON.parse(written[SCHEDULE]!)).toEqual([full]);
  });

  it('is deterministic under --now, whatever the clock says', async () => {
    const run = (now: string) =>
      runCli(
        ['schedule', 'apply', 'production', '--now', '2026-11-10T08:00:00Z', '-f', 'json'],
        files([full, ramp]),
        {
          now: () => new Date(now),
        },
      );
    const early = await run('2020-01-01T00:00:00Z');
    const late = await run('2030-01-01T00:00:00Z');

    expect(late).toEqual(early);
    const report = JSON.parse(early.stdout) as ScheduleApplyReport;
    expect(report).toMatchObject({
      status: 'applied',
      now: '2026-11-10T08:00:00.000Z',
      pending: 0,
    });
    expect(report.applied.map((entry) => entry.id)).toEqual(['checkout-ramp-50', 'checkout-full']);
    expect((JSON.parse(early.written[RULESET]!) as TestRuleset).flags[0]).not.toHaveProperty(
      'allocation',
    );
  });

  it('writes nothing when nothing is due', async () => {
    const { code, stdout, written } = await runSchedule(
      'apply',
      [ramp],
      '--now',
      '2026-11-03T08:59:59Z',
    );
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('production: nothing due at 2026-11-03T08:59:59.000Z; 1 entry pending\n');
    expect(written).toEqual({});
  });

  it('defaults to the current time', async () => {
    const { stdout } = await runSchedule('apply', [ramp]);
    expect(stdout).toBe('production: nothing due at 2026-01-01T00:00:00.000Z; 1 entry pending\n');
  });

  it('refuses a due entry with a bad patch and writes nothing', async () => {
    const broken = { ...ramp, set: { variants: 'on' } };
    const { code, stderr, written } = await runSchedule(
      'apply',
      [broken],
      '--now',
      '2027-01-01T00:00:00Z',
    );

    expect(code).toBe(ExitCode.Findings);
    expect(stderr).toContain(
      'refusing to apply the schedule of production: 1 issue; nothing written',
    );
    expect(written).toEqual({});
  });

  it('exits 2 on a --now without an offset', async () => {
    const { code, stderr } = await runSchedule('apply', [ramp], '--now', '2026-11-03T09:00:00');
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('--now must be a date and time with a UTC offset');
  });
});

describe('patchDocument', () => {
  const flag = { key: 'a', enabled: false, salt: 's' };

  it('patches every ruleset shape', () => {
    const set = { enabled: true, salt: null };
    expect(patchDocument([flag], 'a', set)).toEqual([{ key: 'a', enabled: true }]);
    expect(patchDocument({ a: flag }, 'a', set)).toEqual({ a: { key: 'a', enabled: true } });
    expect(patchDocument({ flags: { a: flag } }, 'a', set)).toEqual({
      flags: { a: { key: 'a', enabled: true } },
    });
    expect(patchDocument({ segments: [] }, 'a', set)).toBeUndefined();
  });
});

describe('parseSchedule', () => {
  it('reads anything but an array as an issue', () => {
    expect(parseSchedule({}).issues).toEqual([
      { entry: '$', message: 'must be an array of entries' },
    ]);
  });

  it('rejects a patch that renames the flag or is empty', () => {
    const issues = parseSchedule([
      { ...ramp, set: { key: 'other' } },
      { ...full, set: {} },
    ]).issues.map((issue) => issue.message);
    expect(issues).toEqual([
      'set cannot change the key of a flag',
      'set must be an object with at least one field',
    ]);
  });
});
