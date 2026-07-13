/**
 * A REAL second process running the REAL CLI, with one thing replaced: the model.
 *
 * `main` is invoked exactly as `bin.ts` invokes it — same commands, same storage, same policy, same
 * sandboxed tool worker, same stdin-backed approval channel. The only injected dependency is the
 * provider, which replays a script from `QH_SCRIPT` so a cross-process test is deterministic
 * without a network call. Everything the test is actually about (persistence, approval, resume)
 * runs the production path.
 *
 * This file is a test fixture: it is never bundled, and `main` gains no flag to reach it.
 */
import { readFileSync } from 'node:fs';

import {
  freezeCapabilities,
  type ModelProvider,
  type ProviderStreamEvent,
} from '@qwen-harness/provider-core';

import { main } from '../../src/main.ts';
import { stdinLineReader } from '../../src/stdin.ts';

const scriptPath = process.env['QH_SCRIPT'];
if (scriptPath === undefined) {
  process.stderr.write('scripted-cli: QH_SCRIPT must point at a JSON round script\n');
  process.exit(64);
}

const rounds = JSON.parse(readFileSync(scriptPath, 'utf8')) as ProviderStreamEvent[][];

let round = 0;
const provider: ModelProvider = {
  capabilities: freezeCapabilities({
    textStreaming: true,
    reasoningSummary: true,
    reasoningEffortGranularity: 'graded',
    incrementalToolArgs: false,
    background: false,
    structuredOutput: false,
    toolStream: false,
  }),
  async *stream() {
    const events = rounds[round++] ?? [{ type: 'done', finishReason: 'stop' }];
    for (const event of events) yield event;
  },
};

main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
  now: () => Date.now(),
  readLine: stdinLineReader(process.stdin, (text) => process.stdout.write(text)),
  provider,
})
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
