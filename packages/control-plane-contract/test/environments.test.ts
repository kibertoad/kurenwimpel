import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  createEnvironmentRequestSchema,
  createProjectRequestSchema,
  environmentSchema,
  updateEnvironmentRequestSchema,
} from '../src/index.js';
import { ENVIRONMENT } from './fixtures.js';

describe('environment resource', () => {
  it('accepts an environment', () => {
    expect(z.safeParse(environmentSchema, ENVIRONMENT).success).toBe(true);
  });

  it('rejects a source other than service or git', () => {
    expect(z.safeParse(environmentSchema, { ...ENVIRONMENT, source: 'both' }).success).toBe(false);
  });

  it('rejects an unknown target type', () => {
    const target = { type: 'gcs', bucket: 'b' };
    expect(z.safeParse(environmentSchema, { ...ENVIRONMENT, target }).success).toBe(false);
  });
});

describe('creating', () => {
  const minimal = {
    key: 'staging',
    name: 'Staging',
    protected: false,
    target: { type: 'r2', bucket: 'flags', key: 'staging.json' },
  };

  it('accepts the minimal environment and leaves the rest to defaults', () => {
    expect(z.safeParse(createEnvironmentRequestSchema, minimal).success).toBe(true);
  });

  it('rejects a key that is not a lowercase slug', () => {
    expect(
      z.safeParse(createEnvironmentRequestSchema, { ...minimal, key: 'Staging' }).success,
    ).toBe(false);
    expect(z.safeParse(createEnvironmentRequestSchema, { ...minimal, key: '-x' }).success).toBe(
      false,
    );
  });

  it('bounds required approvals between 1 and 5', () => {
    const withApprovals = (count: number): boolean =>
      z.safeParse(createEnvironmentRequestSchema, { ...minimal, requiredApprovals: count }).success;
    expect(withApprovals(0)).toBe(false);
    expect(withApprovals(1)).toBe(true);
    expect(withApprovals(5)).toBe(true);
    expect(withApprovals(6)).toBe(false);
  });

  it('rejects a role binding to an unknown role', () => {
    const roleBindings = [{ group: 'everyone', role: 'admin' }];
    expect(z.safeParse(createEnvironmentRequestSchema, { ...minimal, roleBindings }).success).toBe(
      false,
    );
  });

  it('accepts a project with a name, and rejects one without', () => {
    expect(z.safeParse(createProjectRequestSchema, { key: 'shop', name: 'Shop' }).success).toBe(
      true,
    );
    expect(z.safeParse(createProjectRequestSchema, { key: 'shop', name: '' }).success).toBe(false);
  });
});

describe('updating', () => {
  it('accepts a partial update', () => {
    expect(z.safeParse(updateEnvironmentRequestSchema, { protected: true }).success).toBe(true);
  });

  it('hands an environment to Git, but takes one over only through an import', () => {
    expect(z.safeParse(updateEnvironmentRequestSchema, { source: 'git' }).success).toBe(true);
    expect(z.safeParse(updateEnvironmentRequestSchema, { source: 'service' }).success).toBe(false);
  });

  it('rejects a field that cannot be changed', () => {
    expect(z.safeParse(updateEnvironmentRequestSchema, { key: 'prod' }).success).toBe(false);
  });
});
