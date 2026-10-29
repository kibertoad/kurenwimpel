import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig, resolveTarget } from '../src/index.js';

const parse = (raw: unknown) => () => parseConfig(raw, 'k.json');
const withTarget = (target: unknown) => ({ environments: { prod: { target } } });

describe('parseConfig', () => {
  it('accepts every target type with its optional fields', () => {
    const config = parseConfig(
      {
        $schema: './schema.json',
        environments: {
          prod: { target: { type: 'kv', namespaceId: 'n', key: 'flags:v2', keep: 5 } },
          local: { target: { type: 'file', path: '/srv/flags.json' } },
          edge: { target: { type: 'r2', bucket: 'b', key: 'k', accessKeyIdEnv: 'R2_PROD_ID' } },
        },
      },
      'k.json',
    );

    expect(config.environments['prod']?.target).toEqual({
      type: 'kv',
      namespaceId: 'n',
      key: 'flags:v2',
      keep: 5,
    });
    expect(config.environments['edge']?.target).toMatchObject({ accessKeyIdEnv: 'R2_PROD_ID' });
  });

  it('rejects a secret with a pointer to the variable field', () => {
    expect(parse(withTarget({ type: 'kv', namespaceId: 'n', apiToken: 'x' }))).toThrow(
      'k.json: environments.prod.target.apiToken: credentials come from environment variables only; name the variable with apiTokenEnv',
    );
    expect(parse(withTarget({ type: 's3', bucket: 'b', key: 'k', secretAccessKey: 'x' }))).toThrow(
      /secretAccessKeyEnv/u,
    );
  });

  it('names the field that is wrong', () => {
    expect(parse(withTarget({ type: 'ftp' }))).toThrow(
      'target.type must be one of: kv, file, s3, r2',
    );
    expect(parse(withTarget({ type: 'kv' }))).toThrow('target.namespaceId is required');
    expect(parse(withTarget({ type: 'file', path: 'x', keep: 0 }))).toThrow(
      'target.keep must be a whole number of at least 1',
    );
    expect(parse(withTarget({ type: 'file', path: 'x', kepp: 3 }))).toThrow(
      'target.kepp is not a known field',
    );
    expect(parse(withTarget({ type: 's3', bucket: '', key: 'k' }))).toThrow(
      'target.bucket must be a non-empty string',
    );
    expect(parse({ environments: [] })).toThrow('k.json: environments must be an object');
    expect(parse({ environments: {}, extra: 1 })).toThrow(ConfigError);
  });
});

describe('resolveTarget', () => {
  it('resolves a relative file path against the config directory', () => {
    const config = parseConfig(withTarget({ type: 'file', path: 'out/flags.json' }), 'x');
    const target = resolveTarget({ path: 'flags/kurenwimpel.config.json', config }, 'prod');

    expect(target).toEqual({
      type: 'file',
      path: expect.stringMatching(/^flags[/\\]out[/\\]flags\.json$/u),
    });
  });
});
