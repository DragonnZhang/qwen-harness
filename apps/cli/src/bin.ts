#!/usr/bin/env node
/**
 * The CLI executable. Thin — it only adapts the process to the injectable `main`, so `main` stays
 * testable without a real process (deterministic automation, UI-15).
 */
import { main } from './main.ts';

main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
  now: () => Date.now(),
})
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
