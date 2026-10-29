/**
 * The shape of `kurenwimpel.config.json`. Credentials never appear here: a
 * target names the environment variables it reads them from, and the loader
 * rejects any field that looks like a secret.
 */
export interface KurenwimpelConfig {
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
}

export interface EnvironmentConfig {
  readonly target: TargetConfig;
}

export type TargetConfig = KvTargetConfig | FileTargetConfig | ObjectTargetConfig;

/** Workers KV through the Cloudflare REST API. */
export interface KvTargetConfig {
  readonly type: 'kv';
  readonly namespaceId: string;
  /** Falls back to the `CLOUDFLARE_ACCOUNT_ID` environment variable. */
  readonly accountId?: string;
  /** The key `KvFlagProvider` reads. Defaults to `flags:current`. */
  readonly key?: string;
  /** Defaults to `flags:rev:`. */
  readonly revisionPrefix?: string;
  /** Revisions kept for rollback, the current one included. Defaults to 20. */
  readonly keep?: number;
  /** The variable holding the API token. Defaults to `CLOUDFLARE_API_TOKEN`. */
  readonly apiTokenEnv?: string;
}

/** A JSON file written atomically, for ConfigMap or sidecar setups. */
export interface FileTargetConfig {
  readonly type: 'file';
  /** Relative paths resolve against the directory of the config file. */
  readonly path: string;
  /** Revisions kept for rollback in `<path>.revisions/`. Defaults to 20. */
  readonly keep?: number;
}

/** An object PUT to S3 or to anything speaking its API, Cloudflare R2 included. */
export interface ObjectTargetConfig {
  readonly type: 's3' | 'r2';
  readonly bucket: string;
  readonly key: string;
  /**
   * Requests go path style to this origin when set. Without it, `s3` uses
   * `https://<bucket>.s3.<region>.amazonaws.com` and `r2` uses
   * `https://<accountId>.r2.cloudflarestorage.com`.
   */
  readonly endpoint?: string;
  /** Defaults to `us-east-1` for `s3` and `auto` for `r2`. */
  readonly region?: string;
  /** `r2` only, when no endpoint is set. Falls back to `CLOUDFLARE_ACCOUNT_ID`. */
  readonly accountId?: string;
  /** Defaults to `AWS_ACCESS_KEY_ID` for `s3` and `R2_ACCESS_KEY_ID` for `r2`. */
  readonly accessKeyIdEnv?: string;
  /** Defaults to `AWS_SECRET_ACCESS_KEY` for `s3` and `R2_SECRET_ACCESS_KEY` for `r2`. */
  readonly secretAccessKeyEnv?: string;
  /** Defaults to `AWS_SESSION_TOKEN` for `s3`. Optional: unset means no session token. */
  readonly sessionTokenEnv?: string;
}

export const DEFAULT_CONFIG_PATH = 'kurenwimpel.config.json';

export const DEFAULT_KEEP = 20;
