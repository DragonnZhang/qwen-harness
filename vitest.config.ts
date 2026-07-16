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
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/unit/**/*.test.ts',
            'apps/*/test/unit/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
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
          // Security tests spawn REAL sandboxed processes and inspect the REAL process table for
          // orphans. Running files in parallel on a small host makes those checks race each other
          // (one file's children look like another file's orphans, and wall-clock teardown
          // assertions miss under CPU contention). One file at a time keeps them deterministic —
          // the flake policy forbids retry-to-pass, so we remove the contention instead.
          fileParallelism: false,
        },
      },
      {
        test: {
          ...shared,
          name: 'pty',
          include: ['apps/*/test/pty/**/*.test.ts', 'packages/*/test/pty/**/*.test.ts'],
          testTimeout: 120_000,
          fileParallelism: false,
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
          // A benchmark that shares 2 vCPUs with other test files is measuring the scheduler, not
          // the code. Timings taken under contention are meaningless in both directions: they hide
          // regressions on an idle box and invent them on a busy one. The flake policy forbids
          // retry-to-pass, so we remove the contention instead of tolerating the noise.
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
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
      {
        test: {
          ...shared,
          name: 'packaging',
          include: ['packaging/test/**/*.test.ts'],
          // The lifecycle suite compiles the workspace, bundles the CLI, builds a real tarball and
          // installs it into a temp prefix. That is slow, and it is the only test that proves the
          // artifact we actually ship works on a machine that is not this one.
          testTimeout: 300_000,
          hookTimeout: 300_000,
          // These tests install into prefixes and build into `dist/release/`. Running the files in
          // parallel would have them racing over the same staging directory.
          fileParallelism: false,
        },
      },
    ],
  },
});
