import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages export their TypeScript sources under this condition,
    // so tests run against `src/` without a prior build.
    conditions: ['@lulu/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@lulu/source'],
    },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Money and concurrency tests share databases; keep files isolated.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
