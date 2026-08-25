// The tsconfigs are kept out of the sandbox: Stryker rewrites tsconfig
// `extends`/`references` paths through the TypeScript compiler API, which
// typescript@7 (tsgo) does not expose (`ts.parseConfigFileTextToJson`).
// Vitest transforms TypeScript without reading a tsconfig, so the sandbox
// does not need them.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Named explicitly: the default '@stryker-mutator/*' wildcard scans the
  // sibling directory of @stryker-mutator/core, which under pnpm's isolated
  // node_modules does not contain the runner.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  mutate: ['src/**/*.ts'],
  ignorePatterns: ['dist', 'tsconfig*.json'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  // Not incremental: nearly every mutant here is static (schemas are top-level
  // initialisers), and Stryker reuses a static mutant's old result even when a
  // new test targets it — an incremental run reports a stale score. The full
  // run takes seconds anyway.
  thresholds: { high: 90, low: 80 },
};
