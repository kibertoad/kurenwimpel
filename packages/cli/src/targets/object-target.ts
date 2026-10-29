import type { ObjectTargetConfig } from '../config/types.js';
import { signRequest, uriEncode } from './sigv4.js';
import type { AwsCredentials } from './sigv4.js';
import { MIB, requireEnv } from './target.js';
import type { PublishTarget, TargetDeps } from './target.js';

/** The S3 and R2 limit on a single PUT. */
export const OBJECT_MAX_PUT_BYTES = 5 * 1024 * MIB;

const REVISION_HEADER = 'x-amz-meta-revision';

/**
 * One object PUT, signed with SigV4. The object carries its revision as user
 * metadata so the next publish can skip an unchanged document; readers use the
 * ETag the store assigns. Earlier revisions are not kept here: turn on bucket
 * versioning for that.
 */
export function objectTarget(config: ObjectTargetConfig, deps: TargetDeps): PublishTarget {
  const r2 = config.type === 'r2';
  const region = config.region ?? (r2 ? 'auto' : 'us-east-1');
  const url = objectUrl(config, deps, region);
  const credentials = credentialsOf(config, deps);
  const now = deps.now ?? ((): Date => new Date());

  const send = (method: string, headers: Record<string, string>, payload = ''): Promise<Response> =>
    deps.fetch(url, {
      method,
      headers: signRequest({ method, url, headers, payload }, credentials, {
        region,
        service: 's3',
        now: now(),
      }),
      ...(method === 'PUT' ? { body: payload } : {}),
    });

  return {
    description: `${config.type} ${url.origin} bucket ${config.bucket} key ${config.key}`,
    maxPayloadBytes: OBJECT_MAX_PUT_BYTES,
    async currentRevision() {
      const response = await send('HEAD', {});
      if (response.status === 404) return;
      if (!response.ok) {
        throw new Error(`${config.type}: cannot read ${url.href}: HTTP ${response.status}`);
      }
      const revision = response.headers.get(REVISION_HEADER);
      if (revision === null) return;
      return revision;
    },
    async write({ revision, payload, publishedAt }) {
      const response = await send(
        'PUT',
        {
          'content-type': 'application/json',
          [REVISION_HEADER]: revision,
          'x-amz-meta-published-at': publishedAt,
        },
        payload,
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(
          `${config.type}: cannot write ${url.href}: HTTP ${response.status} ${detail}`,
        );
      }
    },
  };
}

function objectUrl(config: ObjectTargetConfig, deps: TargetDeps, region: string): URL {
  const key = config.key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
  if (config.endpoint !== undefined) {
    return new URL(`${config.endpoint.replace(/\/+$/u, '')}/${uriEncode(config.bucket)}/${key}`);
  }
  if (config.type === 's3') {
    return new URL(`https://${config.bucket}.s3.${region}.amazonaws.com/${key}`);
  }
  const account = config.accountId ?? requireEnv(deps, 'CLOUDFLARE_ACCOUNT_ID', 'r2 target');
  return new URL(`https://${account}.r2.cloudflarestorage.com/${uriEncode(config.bucket)}/${key}`);
}

function credentialsOf(config: ObjectTargetConfig, deps: TargetDeps): AwsCredentials {
  const prefix = config.type === 'r2' ? 'R2' : 'AWS';
  const purpose = `${config.type} target`;
  const accessKeyId = requireEnv(deps, config.accessKeyIdEnv ?? `${prefix}_ACCESS_KEY_ID`, purpose);
  const secretAccessKey = requireEnv(
    deps,
    config.secretAccessKeyEnv ?? `${prefix}_SECRET_ACCESS_KEY`,
    purpose,
  );
  const tokenEnv =
    config.sessionTokenEnv ?? (config.type === 's3' ? 'AWS_SESSION_TOKEN' : undefined);
  const sessionToken = tokenEnv === undefined ? undefined : deps.env[tokenEnv];
  return sessionToken === undefined || sessionToken === ''
    ? { accessKeyId, secretAccessKey }
    : { accessKeyId, secretAccessKey, sessionToken };
}
