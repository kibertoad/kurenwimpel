import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  PayloadTooLargeError,
  publishRuleset,
  revisionOf,
  RulesetIssuesError,
} from '../src/index.js';
import type { PublishedRevision, PublishReport, PublishTarget } from '../src/index.js';
import { urlOf } from './fake-kv-api.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';

/** A target that holds one document in memory. */
function memoryTarget(maxPayloadBytes = 1024 * 1024) {
  const written: PublishedRevision[] = [];
  const target: PublishTarget = {
    description: 'memory',
    maxPayloadBytes,
    currentRevision: () => Promise.resolve(written.at(-1)?.revision),
    write: (published) => {
      written.push(published);
      return Promise.resolve();
    },
  };
  return { target, written };
}

function broken(): ReturnType<typeof readmeRuleset> {
  const ruleset = readmeRuleset();
  ruleset.flags[0]!.defaultVariant = 'missing';
  return ruleset;
}

describe('revisionOf', () => {
  it('ignores key order and formatting, and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
    expect(revisionOf({ a: 1, b: 2 }).revision).toBe(revisionOf({ b: 2, a: 1 }).revision);
    expect(revisionOf([1, 2]).revision).not.toBe(revisionOf([2, 1]).revision);
  });

  it('is the hex SHA-256 of the payload', () => {
    expect(revisionOf({}).revision).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});

describe('publishRuleset', () => {
  it('stamps publishedAt and reports the revision it replaced', async () => {
    const { target, written } = memoryTarget();
    await publishRuleset(target, { flags: [] });

    const result = await publishRuleset(target, readmeRuleset(), {
      now: () => new Date('2026-03-01T12:00:00Z'),
    });

    expect(result).toMatchObject({
      status: 'published',
      previousRevision: revisionOf({ flags: [] }).revision,
      issues: [],
    });
    expect(written.at(-1)?.publishedAt).toBe('2026-03-01T12:00:00.000Z');
  });

  it('refuses a document with parse issues and writes nothing', async () => {
    const { target, written } = memoryTarget();

    await expect(publishRuleset(target, broken())).rejects.toBeInstanceOf(RulesetIssuesError);
    expect(written).toHaveLength(0);
  });

  it('refuses a payload over the target limit before touching the target', async () => {
    const { target, written } = memoryTarget(10);

    const error = await publishRuleset(target, readmeRuleset()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect(error).toMatchObject({ limit: 10, bytes: revisionOf(readmeRuleset()).payload.length });
    expect(written).toHaveLength(0);
  });
});

describe('kurenwimpel publish', () => {
  const config = { environments: { local: { target: { type: 'file', path: 'unused.json' } } } };

  it('exits 1 on parse issues, before reading the config', async () => {
    const { code, stdout, stderr } = await runCli(
      ['publish', 'local', 'bad.json', '--format', 'json'],
      { 'bad.json': broken() },
    );

    expect(code).toBe(ExitCode.Findings);
    expect(stderr).toContain('refusing to publish bad.json: 1 parse issue');
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'refused',
      issues: [{ at: 'new-checkout' }],
    });
  });

  it('publishes with --allow-issues and says so loudly', async () => {
    const { code, stdout, stderr } = await runCli(
      ['publish', 'local', 'bad.json', '--allow-issues', '-f', 'json', '-c', 'k.json'],
      {
        'bad.json': broken(),
        'k.json': { environments: { local: { target: { type: 'kv', namespaceId: 'n' } } } },
      },
      { env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, fetch: allowAll },
    );

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toContain('WARNING: --allow-issues published bad.json with 1 parse issue.');
    expect((JSON.parse(stdout) as PublishReport).issues).toHaveLength(1);
  });

  it('exits 2 on a wrong number of arguments or an unknown environment', async () => {
    const files = { 'kurenwimpel.config.json': config, 'a.json': readmeRuleset() };

    expect((await runCli(['publish', 'local'], files)).stderr).toContain('expected <env> <file>');
    const unknown = await runCli(['publish', 'staging', 'a.json'], files);
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.stderr).toContain(
      'environment "staging" is not in kurenwimpel.config.json (configured: local)',
    );
  });
});

/** A Cloudflare API that accepts every write and holds no keys. */
function allowAll(input: string | URL | Request): Promise<Response> {
  const status = urlOf(input).includes('/metadata/') ? 404 : 200;
  return Promise.resolve(
    new Response(JSON.stringify({ success: status === 200, result: [] }), { status }),
  );
}
