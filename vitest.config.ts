import { defineConfig } from 'vitest/config';

/**
 * `vitest run`           → database tests on PGlite (fast, single connection)
 * `vitest run --mode pg` → database tests on real PostgreSQL (TEST_DATABASE_URL, or an
 *                          embedded server started by the global setup). Required
 *                          before release: PGlite results are not final sign-off.
 */
export default defineConfig(({ mode }) => {
  // Set here (main process) so the global setup and every worker see it.
  if (mode === 'pg') process.env.LULU_TEST_DB = 'postgres';

  return {
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
      include: [
        '{apps,packages}/*/src/**/*.test.{ts,tsx}',
        'tests/**/*.test.ts',
        'scripts/**/*.test.ts',
      ],
      environment: 'node',
      globalSetup: ['tests/setup/postgres-global-setup.ts'],
      reporters: ['default', './tests/setup/strict-reporter.ts'],
      // Money and concurrency tests use their own databases; keep files isolated.
      pool: 'forks',
      // Each PGlite database is a full PostgreSQL in WebAssembly (hundreds of MB);
      // one worker per CPU core exhausts memory on large machines and crashes workers.
      maxWorkers: 6,
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  };
});
