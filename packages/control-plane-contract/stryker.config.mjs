// The tsconfigs stay out of the sandbox: Stryker rewrites tsconfig
// `extends`/`references` paths through the TypeScript compiler API, which
// typescript@7 (tsgo) does not expose. Vitest needs no tsconfig.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Named explicitly: under pnpm's isolated node_modules the default
  // '@stryker-mutator/*' wildcard does not find the runner.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  mutate: ['src/**/*.ts'],
  ignorePatterns: ['dist', 'tsconfig*.json'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  // Not incremental: the schemas are top-level initialisers, so nearly every
  // mutant is static, and Stryker reuses a static mutant's old result.
  thresholds: { high: 90, low: 80 },
};
