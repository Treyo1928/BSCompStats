import { defineConfig } from 'vitest/config';

// The integration tests talk to a running app over HTTP; see scripts/test-integration.sh.
export default defineConfig({
  test: {
    include: ['apps/web/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One app, one database: the suites share state, so they run one after another, in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
