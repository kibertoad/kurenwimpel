import { describe, expect, it } from 'vitest';

import type { CliIo, LintReport } from '../src/index.js';
import { ExitCode, runCli } from './fixtures.js';
import type { IoOverrides } from './fixtures.js';

const NOW = '2026-06-15T12:00:00Z';

function flag(key: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'off',
    offVariant: 'off',
    rules: [{ id: 'beta', conditions: [{ attribute: 'beta', operator: 'exists' }], variant: 'on' }],
    ...fields,
  };
}

async function lint(
  flags: readonly unknown[],
  extra: readonly string[] = [],
  overrides: IoOverrides = {},
): Promise<{ code: number; report: LintReport; stderr: string }> {
  const files = {
    'flags.json': { flags },
    'config.json': { environments: {}, lint: { requireOwner: true } },
  };
  const { code, stdout, stderr } = await runCli(
    ['lint', 'flags.json', '--now', NOW, '-f', 'json', ...extra],
    files,
    overrides,
  );
  return { code, report: JSON.parse(stdout) as LintReport, stderr };
}

async function rulesFor(definition: unknown): Promise<string[]> {
  const { report } = await lint([definition]);
  return report.findings.map((finding) => finding.rule);
}

const constant = { rules: [], defaultVariant: 'on' };

describe('kurenwimpel lint rules', () => {
  it.each([
    ['a flag still being rolled out', flag('a'), []],
    [
      'a release past its expiry',
      flag('a', { lifecycle: { expiresOn: '2026-06-14' } }),
      ['expired'],
    ],
    ['a flag expiring today', flag('a', { lifecycle: { expiresOn: '2026-06-15' } }), []],
    ['a flag serving one variant', flag('a', constant), ['fully-rolled-out']],
    [
      'a rule serving the default',
      flag('a', { rules: [{ id: 'r', conditions: [], variant: 'off' }] }),
      ['fully-rolled-out'],
    ],
    [
      'a split with one weighted bucket',
      flag('a', {
        rules: [],
        rollout: [
          { variant: 'on', weight: 1 },
          { variant: 'off', weight: 0 },
        ],
      }),
      ['fully-rolled-out'],
    ],
    [
      'a catch-all rule above a split',
      flag('a', {
        rules: [{ id: 'all', conditions: [], variant: 'off' }],
        rollout: [{ variant: 'on', weight: 1 }],
      }),
      ['fully-rolled-out'],
    ],
    [
      'a parked rule split',
      flag('a', { rules: [{ id: 'r', conditions: [], rollout: [{ variant: 'on', weight: 0 }] }] }),
      ['fully-rolled-out'],
    ],
    [
      'an allocation below 100',
      flag('a', {
        ...constant,
        defaultVariant: 'off',
        rollout: [{ variant: 'on', weight: 1 }],
        allocation: { percent: 50 },
      }),
      [],
    ],
    [
      'an allocation at 100',
      flag('a', { ...constant, allocation: { percent: 100 } }),
      ['fully-rolled-out'],
    ],
    [
      'a prerequisite that can fail',
      flag('a', { ...constant, prerequisites: [{ flag: 'b', variants: ['on'] }] }),
      [],
    ],
    ['a disabled flag', flag('a', { enabled: false }), ['permanently-off']],
    [
      'a disabled flag past its expiry',
      flag('a', { enabled: false, lifecycle: { expiresOn: '2025-01-01' } }),
      ['expired', 'permanently-off'],
    ],
  ])('%s', async (_, definition, expected) => {
    expect(await rulesFor(definition)).toEqual(expected);
  });

  it.each(['ops', 'permission'])('exempts %s flags from every staleness rule', async (kind) => {
    const lifecycle = { kind, expiresOn: '2025-01-01' };
    expect(await rulesFor(flag('a', { ...constant, lifecycle }))).toEqual([]);
    expect(await rulesFor(flag('a', { enabled: false, lifecycle }))).toEqual([]);
  });

  it.each(['release', 'experiment'])('checks %s flags', async (kind) => {
    const lifecycle = { kind, expiresOn: '2025-01-01' };
    expect(await rulesFor(flag('a', { ...constant, lifecycle }))).toEqual([
      'expired',
      'fully-rolled-out',
    ]);
  });

  it('describes each finding', async () => {
    const { code, report } = await lint([
      flag('old', { lifecycle: { expiresOn: '2026-01-31' } }),
      flag('done', constant),
      flag('dark', { enabled: false }),
    ]);
    expect(code).toBe(ExitCode.Findings);
    expect(report).toEqual({
      file: 'flags.json',
      now: '2026-06-15T12:00:00.000Z',
      issues: [],
      findings: [
        {
          flag: 'old',
          rule: 'expired',
          severity: 'error',
          expiresOn: '2026-01-31',
          message:
            'expired on 2026-01-31; remove it, or move lifecycle.expiresOn if it has to stay',
        },
        {
          flag: 'done',
          rule: 'fully-rolled-out',
          severity: 'warning',
          variant: 'on',
          message: 'serves "on" to everyone outside its targets; remove it and keep that code path',
        },
        {
          flag: 'dark',
          rule: 'permanently-off',
          severity: 'warning',
          message: 'is switched off; remove it and its code path, or switch it on',
        },
      ],
    });
  });

  it('exits 0 with no findings', async () => {
    const { code, report } = await lint([flag('a')]);
    expect(code).toBe(ExitCode.Ok);
    expect(report.findings).toEqual([]);
  });
});

describe('the missing-owner warning', () => {
  const owned = flag('owned', { lifecycle: { owner: 'team-checkout' } });

  it('is off without a config', async () => {
    expect((await lint([flag('a')])).report.findings).toEqual([]);
  });

  it('is turned on by the config, ops flags included', async () => {
    const opsFlag = flag('ops', { lifecycle: { kind: 'ops' } });
    const { report } = await lint([owned, opsFlag], ['--config', 'config.json']);
    expect(report.findings).toEqual([
      {
        flag: 'ops',
        rule: 'missing-owner',
        severity: 'warning',
        message: 'has no lifecycle.owner; name the team that will remove it',
      },
    ]);
  });

  it('stays off when the config does not ask for it', async () => {
    const { code } = await runCli(['lint', 'flags.json', '-c', 'config.json'], {
      'flags.json': [flag('a')],
      'config.json': { environments: {}, lint: {} },
    });
    expect(code).toBe(ExitCode.Ok);
  });
});

/** `ls-files` prints nothing for a file git does not track. */
const untracked: CliIo['git'] = () => Promise.resolve('');

describe('kurenwimpel lint --since-git', () => {
  const on = { flags: [flag('dark'), flag('other')] };
  const off = { flags: [flag('dark', { enabled: false }), flag('other')] };
  const revisions: Record<string, unknown> = { c3: off, c2: off, c1: on, c0: off };

  function git(log: string): CliIo['git'] {
    return (args) => {
      const [command, target] = args;
      if (command === 'ls-files') return Promise.resolve('flags/prod.json\n');
      if (command === 'log') return Promise.resolve(log);
      const sha = target?.split(':')[0] ?? '';
      return Promise.resolve(sha in revisions ? JSON.stringify(revisions[sha]) : '{ broken');
    };
  }

  const log = [
    'c3 2026-05-20T09:00:00+00:00',
    'c2 2026-03-01T10:00:00+00:00',
    'c1 2026-02-01T10:00:00+00:00',
    'c0 2026-01-01T10:00:00+00:00',
  ].join('\n');

  it('reports how long a flag has been off', async () => {
    const { report } = await lint(off.flags, ['--since-git'], { git: git(log) });
    expect(report.findings).toEqual([
      expect.objectContaining({
        flag: 'dark',
        offSince: '2026-03-01T10:00:00+00:00',
        offDays: 106,
        message:
          'has been switched off since 2026-03-01 (106 days); remove it and its code path, or switch it on',
      }),
    ]);
  });

  it('dates a flag off since its first commit, and stops at a revision that is not JSON', async () => {
    const first = await lint(off.flags, ['--since-git'], {
      git: git(log.split('\n').slice(0, 2).join('\n')),
    });
    expect(first.report.findings[0]?.offSince).toBe('2026-03-01T10:00:00+00:00');

    const broken = await lint(off.flags, ['--since-git'], {
      git: git('c3 2026-05-20T09:00:00+00:00\nbad 2026-03-01T10:00:00+00:00\n'),
    });
    expect(broken.report.findings[0]?.offSince).toBe('2026-05-20T09:00:00+00:00');
  });

  it('leaves the date out for a file git does not track', async () => {
    const { report } = await lint(off.flags, ['--since-git'], { git: untracked });
    expect(report.findings[0]?.offSince).toBeUndefined();
  });

  it('exits 2 when git fails', async () => {
    const { code, stderr } = await runCli(['lint', 'flags.json', '--since-git'], {
      'flags.json': off,
    });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('--since-git: no git in tests');
  });
});

describe('kurenwimpel lint output', () => {
  const ruleset = `{\n  "flags": [\n    ${JSON.stringify(flag('done', constant))}\n  ]\n}\n`;

  async function render(format: string): Promise<string> {
    const files = { 'flags.json': ruleset };
    return (await runCli(['lint', 'flags.json', '--now', NOW, '-f', format], files)).stdout;
  }

  it('prints text', async () => {
    expect(await render('text')).toBe(
      'flags.json: 1 finding\n  [fully-rolled-out] done serves "on" to everyone outside its targets; remove it and keep that code path\n',
    );
  });

  it('prints a pull request comment section', async () => {
    expect(await render('markdown')).toBe(
      '### Lint\n\n`flags.json`: **1 finding**.\n\n- **fully-rolled-out**: `done` serves "on" to everyone outside its targets; remove it and keep that code path\n',
    );
  });

  it('prints a warning annotation on the line of the flag', async () => {
    expect(await render('github')).toBe(
      '::warning file=flags.json,line=3,title=kurenwimpel lint%3A fully-rolled-out::done serves "on" to everyone outside its targets; remove it and keep that code path\n',
    );
  });

  it('says when there is nothing to remove', async () => {
    const files = { 'flags.json': [flag('a')] };
    const { stdout } = await runCli(['lint', 'flags.json', '-f', 'markdown'], files);
    expect(stdout).toBe('### Lint\n\n`flags.json`: no findings (1 flag).\n');
  });

  it('rejects a --now that is not a date, and a second file', async () => {
    const files = { 'flags.json': [flag('a')] };
    const bad = await runCli(['lint', 'flags.json', '--now', 'yesterday'], files);
    expect(bad.code).toBe(ExitCode.Usage);
    expect(bad.stderr).toContain('--now must be a date');
    expect((await runCli(['lint', 'flags.json', 'other.json'], files)).code).toBe(ExitCode.Usage);
  });

  it('lints what parsed and warns about the rest', async () => {
    const { report, stderr } = await lint([flag('done', constant), { key: 'broken' }]);
    expect(report.findings.map((finding) => finding.flag)).toEqual(['done']);
    expect(report.issues).toHaveLength(1);
    expect(stderr).toContain('warning: flags.json: broken:');
  });
});
