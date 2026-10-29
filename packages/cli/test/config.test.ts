import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig, resolveRuleset, resolveTarget } from '../src/index.js';

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

  it('reads the lint block', () => {
    expect(parseConfig({ environments: {}, lint: { requireOwner: true } }, 'k.json').lint).toEqual({
      requireOwner: true,
    });
    expect(parseConfig({ environments: {}, lint: {} }, 'k.json').lint).toEqual({});
    expect(parse({ environments: {}, lint: { requireOwner: 'yes' } })).toThrow(
      'k.json: lint.requireOwner must be a boolean',
    );
    expect(parse({ environments: {}, lint: { owners: true } })).toThrow(
      'k.json: lint.owners is not a known field (expected requireOwner)',
    );
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

describe('environment fields', () => {
  const target = { type: 'file', path: 'x' };

  it('accepts a ruleset path and approvers', () => {
    const config = parseConfig(
      { environments: { prod: { target, ruleset: 'p.json', approvers: ['@acme/flags'] } } },
      'k.json',
    );
    expect(config.environments['prod']).toEqual({
      target,
      ruleset: 'p.json',
      approvers: ['@acme/flags'],
    });
  });

  it('rejects approvers that are not a list of owners', () => {
    const message =
      'environments.prod.approvers must be a non-empty array of owners without spaces';
    for (const approvers of [[], '@acme/flags', ['@acme flags'], [3]]) {
      expect(parse({ environments: { prod: { target, approvers } } })).toThrow(message);
    }
    expect(parse({ environments: { prod: { target, ruleset: '' } } })).toThrow(
      'environments.prod.ruleset must be a non-empty string',
    );
  });

  it('resolves the ruleset against the config directory, defaulting to <env>.json', () => {
    const config = parseConfig(
      { environments: { prod: { target }, dev: { target, ruleset: 'd/dev.json' } } },
      'x',
    );
    const loaded = { path: 'flags/kurenwimpel.config.json', config };

    expect(resolveRuleset(loaded, 'prod')).toMatch(/^flags[/\\]prod\.json$/u);
    expect(resolveRuleset(loaded, 'dev')).toMatch(/^flags[/\\]d[/\\]dev\.json$/u);
    expect(() => resolveRuleset(loaded, 'qa')).toThrow('environment "qa" is not in');
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
