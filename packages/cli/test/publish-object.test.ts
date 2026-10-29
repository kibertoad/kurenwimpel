import { describe, expect, it } from 'vitest';

import { revisionOf } from '../src/index.js';
import { ExitCode, readmeRuleset, runCli } from './fixtures.js';

interface Stored {
  body: string;
  revision: string | null;
}

/** One bucket that answers HEAD and PUT, and records what it was sent. */
function fakeBucket() {
  const objects = new Map<string, Stored>();
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const stored = objects.get(request.url);
    if (request.method === 'HEAD') {
      if (stored === undefined) return new Response(null, { status: 404 });
      return new Response(null, { headers: { 'x-amz-meta-revision': stored.revision ?? '' } });
    }
    objects.set(request.url, {
      body: await request.text(),
      revision: request.headers.get('x-amz-meta-revision'),
    });
    return new Response(null, { status: 200 });
  };
  return { objects, requests, fetch };
}

const files = (target: Record<string, unknown>) => ({
  'kurenwimpel.config.json': { environments: { edge: { target } } },
  'flags.json': readmeRuleset(),
});

describe('kurenwimpel publish to s3 and r2', () => {
  it('PUTs the canonical JSON to R2, signed, with the revision as user metadata', async () => {
    const bucket = fakeBucket();
    const env = {
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      CLOUDFLARE_ACCOUNT_ID: 'acc',
    };
    const { revision, payload } = revisionOf(readmeRuleset());

    const { code } = await runCli(
      ['publish', 'edge', 'flags.json'],
      files({ type: 'r2', bucket: 'flags', key: 'prod/flags.json' }),
      { env, fetch: bucket.fetch },
    );

    expect(code).toBe(ExitCode.Ok);
    const url = 'https://acc.r2.cloudflarestorage.com/flags/prod/flags.json';
    expect(bucket.objects.get(url)).toEqual({ body: payload, revision });
    const put = bucket.requests.find((request) => request.method === 'PUT')!;
    expect(put.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=id\/20260101\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;/u,
    );
    expect(put.headers.get('content-type')).toBe('application/json');
  });

  it('skips the PUT when the object already carries the revision', async () => {
    const bucket = fakeBucket();
    const env = { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' };
    const config = files({ type: 's3', bucket: 'flags', key: 'flags.json', region: 'eu-west-1' });

    await runCli(['publish', 'edge', 'flags.json'], config, { env, fetch: bucket.fetch });
    const second = await runCli(['publish', 'edge', 'flags.json'], config, {
      env,
      fetch: bucket.fetch,
    });

    expect(second.stdout).toContain('nothing written');
    expect(bucket.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'HEAD https://flags.s3.eu-west-1.amazonaws.com/flags.json',
      'PUT https://flags.s3.eu-west-1.amazonaws.com/flags.json',
      'HEAD https://flags.s3.eu-west-1.amazonaws.com/flags.json',
    ]);
  });

  it('goes path style to a custom endpoint and sends the session token', async () => {
    const bucket = fakeBucket();
    const env = {
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'tok',
    };
    const target = {
      type: 's3',
      bucket: 'flags',
      key: 'flags.json',
      endpoint: 'http://localhost:9000/',
    };

    await runCli(['publish', 'edge', 'flags.json'], files(target), { env, fetch: bucket.fetch });

    expect(bucket.requests[1]?.url).toBe('http://localhost:9000/flags/flags.json');
    expect(bucket.requests[1]?.headers.get('x-amz-security-token')).toBe('tok');
  });

  it('exits 2 without credentials, and has no revisions to roll back to', async () => {
    const config = files({ type: 's3', bucket: 'flags', key: 'flags.json' });

    const missing = await runCli(['publish', 'edge', 'flags.json'], config);
    expect(missing.code).toBe(ExitCode.Usage);
    expect(missing.stderr).toContain('environment variable AWS_ACCESS_KEY_ID is not set');

    const env = { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' };
    const rollback = await runCli(['rollback', 'edge'], config, { env });
    expect(rollback.code).toBe(ExitCode.Usage);
    expect(rollback.stderr).toContain('keeps no revisions to roll back to');
  });

  it('reports a rejected PUT with its status', async () => {
    const env = { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' };
    const fetch = rejectingBucket;

    const { code, stderr } = await runCli(
      ['publish', 'edge', 'flags.json'],
      files({ type: 's3', bucket: 'flags', key: 'flags.json' }),
      { env, fetch },
    );

    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('HTTP 403 <Error>SignatureDoesNotMatch</Error>');
  });
});

/** A bucket that has no object and rejects every signature. */
function rejectingBucket(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return Promise.resolve(
    init?.method === 'HEAD'
      ? new Response(null, { status: 404 })
      : new Response('<Error>SignatureDoesNotMatch</Error>', { status: 403 }),
  );
}
