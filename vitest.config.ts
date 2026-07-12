import { defineConfig } from 'vitest/config';

/**
 * One config, many named projects. Each root `test:*` script maps to exactly one project, so a
 * gate can never silently run the wrong suite. `pnpm check` composes every deterministic project;
 * `live` is deliberately excluded from it and is only run by `pnpm test:live`.
 */
const shared = {
  globals: false,
  // No test may hang a gate. Bounded by construction, not by hope.
  testTimeout: 30_000,
  hookTimeout: 30_000,
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          include: [
            'packages/*/test/integration/**/*.test.ts',
            'apps/*/test/integration/**/*.test.ts',
          ],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'security',
          include: ['packages/*/test/security/**/*.test.ts', 'apps/*/test/security/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'pty',
          include: ['apps/*/test/pty/**/*.test.ts', 'packages/*/test/pty/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'e2e',
          include: ['evals/e2e/**/*.test.ts'],
          testTimeout: 180_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'live',
          include: ['evals/live/**/*.test.ts'],
          testTimeout: 300_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'performance',
          include: [
            'packages/*/test/performance/**/*.test.ts',
            'apps/*/test/performance/**/*.test.ts',
          ],
          testTimeout: 300_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'migrations',
          include: ['packages/*/test/migrations/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
