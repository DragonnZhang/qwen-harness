// Team golden-path child process (checkpoint 10, path 5).
//
// This is NOT a test file — vitest's e2e project only picks up `*.test.ts`, and tsc ignores `.mjs`.
// It is a REAL, separate OS process that drives the production CLI `main()` (`@qwen-harness/cli`,
// resolved to the built package via `evals/node_modules`). The e2e uses it two ways:
//
//   1. the test spawns it to run the LEAD  (`team run ...`);
//   2. the LEAD spawns it AGAIN, once per teammate, to run each TEAMMATE (`team teammate ...`) as its
//      own process. That second spawn is what makes a teammate a genuine separate, sandboxed worker
//      in its OWN git worktree — never a thread and never the lead's process.
//
// `teamWorker` is set to THIS script's own path, so the lead re-invokes exactly this entry for its
// teammates. Time is injected (`now`); the orchestration, isolation, claiming, and the managed
// ceiling are all the production paths.
//
//   argv:  <cwd> <nowMs> <managedPath|-> <...cliArgs>
//   stdout: whatever the CLI printed; exit code: the CLI's exit code.

import { fileURLToPath } from 'node:url';

import { main } from '@qwen-harness/cli';

const self = fileURLToPath(import.meta.url);
const [, , cwd, nowStr, managedPath, ...cliArgs] = process.argv;
const now = Number(nowStr);

const code = await main({
  argv: cliArgs,
  env: process.env,
  cwd,
  now: () => now,
  teamWorker: self,
  ...(managedPath && managedPath !== '-' ? { managedPath } : {}),
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
});

process.exit(code);
