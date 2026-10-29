import { describe, expect, it } from 'vitest';

import { revisionOf } from '../src/index.js';
import type { PublishReport, RevisionsReport } from '../src/index.js';
import { ACCOUNT, FakeKvApi, NAMESPACE, TOKEN } from './fake-kv-api.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';
import type { CliOutcome } from './fixtures.js';

const config = (target: Record<string, unknown> = {}): unknown => ({
  environments: {
    production: { target: { type: 'kv', accountId: ACCOUNT, namespaceId: NAMESPACE, ...target } },
  },
});

/** A minute later on every call, so each publish gets its own timestamp. */
function clock(): () => Date {
  let minutes = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, minutes++));
}

function edition(enabled: boolean): unknown {
  const ruleset = readmeRuleset();
  ruleset.flags[1]!.enabled = enabled;
  return ruleset;
}

function setup(target: Record<string, unknown> = {}) {
  const kv = new FakeKvApi();
  const files: Record<string, unknown> = {
    'kurenwimpel.config.json': config(target),
    'a.json': edition(true),
    'b.json': edition(false),
  };
  const io = { env: { CLOUDFLARE_API_TOKEN: TOKEN }, fetch: kv.fetch, now: clock() };
  const cli = (...argv: string[]): Promise<CliOutcome> => runCli(argv, files, io);
  return { kv, files, cli };
}

describe('kurenwimpel publish to kv', () => {
  it('writes the revision key first, then the current key with { revision } metadata', async () => {
    const { kv, cli } = setup();
    const { revision, payload } = revisionOf(edition(true));

    const { code, stdout } = await cli('publish', 'production', 'a.json');

    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain(
      `production: published ${revision} to kv namespace ns-1 key flags:current`,
    );
    expect(kv.writes().map((request) => request.path)).toEqual([
      `/values/flags:rev:${revision}`,
      '/values/flags:current',
    ]);
    expect(kv.entries.get('flags:current')).toEqual({ value: payload, metadata: { revision } });
    expect(kv.entries.get(`flags:rev:${revision}`)).toEqual({
      value: payload,
      metadata: { revision, publishedAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('writes nothing when the same document is published again', async () => {
    const { kv, cli } = setup();
    await cli('publish', 'production', 'a.json');
    const writes = kv.writes().length;

    const { code, stdout } = await cli('publish', 'production', 'a.json', '--format', 'json');

    expect(code).toBe(ExitCode.Ok);
    expect((JSON.parse(stdout) as PublishReport).status).toBe('unchanged');
    expect(kv.writes()).toHaveLength(writes);
  });

  it('reads the token from the variable the config names, and nowhere else', async () => {
    const { files, kv } = setup({ apiTokenEnv: 'PROD_CF_TOKEN' });
    const io = { env: { PROD_CF_TOKEN: TOKEN }, fetch: kv.fetch };

    expect((await runCli(['publish', 'production', 'a.json'], files, io)).code).toBe(ExitCode.Ok);

    const missing = await runCli(['publish', 'production', 'a.json'], files, { fetch: kv.fetch });
    expect(missing.code).toBe(ExitCode.Usage);
    expect(missing.stderr).toContain('environment variable PROD_CF_TOKEN is not set');
  });

  it('takes the account id from CLOUDFLARE_ACCOUNT_ID when the config has none', async () => {
    const kv = new FakeKvApi();
    const files = {
      'flags.config.json': {
        environments: { prod: { target: { type: 'kv', namespaceId: NAMESPACE } } },
      },
      'a.json': edition(true),
    };
    const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };

    const { code } = await runCli(
      ['publish', 'prod', 'a.json', '--config', 'flags.config.json'],
      files,
      { env, fetch: kv.fetch },
    );

    expect(code).toBe(ExitCode.Ok);
    expect(kv.entries.has('flags:current')).toBe(true);
  });

  it('prunes all but the newest revisions on publish', async () => {
    const { files, cli } = setup({ keep: 2 });
    const editions = [0, 1, 2, 3].map((n) => {
      const ruleset = readmeRuleset();
      ruleset.flags[1]!.metadata = { edition: String(n) };
      files[`e${n}.json`] = ruleset;
      return revisionOf(ruleset).revision;
    });
    await cli('publish', 'production', 'e0.json');
    await cli('publish', 'production', 'e1.json');
    await cli('publish', 'production', 'e2.json');
    await cli('rollback', 'production', '--to', editions[0]!);

    await cli('publish', 'production', 'e3.json');

    const { stdout } = await cli('revisions', 'production', '--format', 'json');
    const stored = (JSON.parse(stdout) as RevisionsReport).revisions.map((entry) => entry.revision);
    expect(stored).toEqual([editions[3], editions[2]]);
  });
});

describe('kurenwimpel rollback on kv', () => {
  it('repoints the current key at the previous revision without touching history', async () => {
    const { kv, cli } = setup();
    await cli('publish', 'production', 'a.json');
    await cli('publish', 'production', 'b.json');
    const a = revisionOf(edition(true));
    const b = revisionOf(edition(false));

    const { code, stdout } = await cli('rollback', 'production');

    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe(`production: rolled back from ${b.revision} to ${a.revision}\n`);
    expect(kv.entries.get('flags:current')).toEqual({
      value: a.payload,
      metadata: { revision: a.revision },
    });
    expect(kv.entries.has(`flags:rev:${b.revision}`)).toBe(true);
  });

  it('rolls forward to a revision named by a unique prefix', async () => {
    const { kv, cli } = setup();
    await cli('publish', 'production', 'a.json');
    await cli('publish', 'production', 'b.json');
    await cli('rollback', 'production');
    const b = revisionOf(edition(false)).revision;

    const { code } = await cli('rollback', 'production', '--to', b.slice(0, 10));

    expect(code).toBe(ExitCode.Ok);
    expect(kv.entries.get('flags:current')?.metadata).toEqual({ revision: b });
  });

  it('exits 2 with nothing earlier to go back to, or an unknown revision', async () => {
    const { kv, cli } = setup();
    await cli('publish', 'production', 'a.json');
    const writes = kv.writes().length;

    const first = await cli('rollback', 'production');
    expect(first.code).toBe(ExitCode.Usage);
    expect(first.stderr).toContain('no earlier revision is stored');

    const unknown = await cli('rollback', 'production', '--to', 'feedface');
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.stderr).toContain('revision feedface is not stored');
    expect(kv.writes()).toHaveLength(writes);
  });

  it('lists revisions newest first and marks the live one', async () => {
    const { cli } = setup();
    await cli('publish', 'production', 'a.json');
    await cli('publish', 'production', 'b.json');
    await cli('rollback', 'production');

    const { stdout } = await cli('revisions', 'production');

    expect(stdout).toBe(
      [
        `  ${revisionOf(edition(false)).revision}  2026-01-01T00:01:00.000Z`,
        `* ${revisionOf(edition(true)).revision}  2026-01-01T00:00:00.000Z`,
        '',
      ].join('\n'),
    );
  });
});
