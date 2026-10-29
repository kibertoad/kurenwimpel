import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    benchmark: { include: ['bench/**/*.bench.ts'] },
    // Lets bench/heap.ts force a collection before and after a build.
    execArgv: ['--expose-gc'],
  },
});
