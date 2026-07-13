// Scheduling golden-path child process (checkpoint 10, path 6).
//
// This is NOT a test file — vitest's e2e project only picks up `*.test.ts`, and tsc ignores `.mjs`.
// It is a REAL, separate OS process that drives the production CLI `main()` (`@qwen-harness/cli`,
// resolved to the built package via `evals/node_modules`), so the golden path can prove that a cron
// job / background task SURVIVES a real process restart: one process creates the durable definition
// and exits; a second, fresh process reconstructs it from the event log and fires it.
//
// Time is injected (`now`), so cron minute markers are deterministic without wall-clock waits — the
// SCHEDULING and DURABILITY are real, only the clock is controlled. The managed-policy path is
// injected the same way `provider` is (test-only; `bin.ts` never sets it), so a test can prove the
// managed ceiling clamps scheduled work without writing to a system path.
//
//   argv:  <cwd> <nowMs> <managedPath|-> <...cliArgs>
//   stdout: whatever the CLI printed; exit code: the CLI's exit code.

import { main } from '@qwen-harness/cli';

const [, , cwd, nowStr, managedPath, ...cliArgs] = process.argv;
const now = Number(nowStr);

const code = await main({
  argv: cliArgs,
  env: process.env,
  cwd,
  now: () => now,
  ...(managedPath && managedPath !== '-' ? { managedPath } : {}),
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
});

process.exit(code);
