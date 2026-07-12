/**
 * The tool-worker entry point. **This process runs INSIDE the sandbox.**
 *
 * It speaks newline-delimited JSON frames over stdin/stdout. That transport is deliberate: it
 * needs no network, no shared filesystem, and no IPC namespace, so the sandbox can be maximally
 * restrictive — bubblewrap can `--unshare-all` and still leave this channel working, because
 * inherited file descriptors survive namespace isolation.
 *
 * The worker trusts NOTHING it receives. Every frame is schema-validated, and every path is
 * re-canonicalized here rather than being taken on the runtime's word. The runtime is not the
 * adversary, but a confused-deputy bug in the runtime should not become a sandbox escape.
 */
import { createInterface } from 'node:readline';

import { handleRequest, WorkerFailure, type HandleRoots } from './handlers.ts';
import { WorkerFrameSchema, type WorkerFrame, type WorkerResponse } from './rpc.ts';

/**
 * The roots the sandbox bound, passed in by the parent at spawn time.
 *
 * These are the paths as seen FROM INSIDE the sandbox. bubblewrap binds the real workspace to a
 * fixed internal mountpoint, so the worker never learns the host path — one more thing that
 * cannot leak into a tool result or a model prompt.
 */
function rootsFromEnv(): HandleRoots {
  const workspace = process.env['QH_WORKSPACE_ROOT'];
  const scratch = process.env['QH_SCRATCH_ROOT'];
  if (!workspace || !scratch) {
    throw new Error('tool-worker requires QH_WORKSPACE_ROOT and QH_SCRATCH_ROOT');
  }
  return { workspace, scratch };
}

async function main(): Promise<void> {
  const roots = rootsFromEnv();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;

    let frame: WorkerFrame;
    try {
      frame = WorkerFrameSchema.parse(JSON.parse(line));
    } catch (e) {
      // A malformed frame is not something we try to interpret. We say so and carry on.
      respond('unknown', {
        ok: false,
        error: { category: 'invalid-input', message: `unparseable frame: ${String(e)}` },
      });
      continue;
    }

    if (frame.body.kind !== 'request') continue;

    const { grant, request } = frame.body;
    const controller = new AbortController();
    // Every operation is time-bounded. A tool that hangs is cancelled, never left to hang the turn.
    const timer = setTimeout(() => controller.abort(), grant.limits.wallMs);

    try {
      const result = await handleRequest({ roots, grant, signal: controller.signal }, request);
      respond(frame.id, { ok: true, result });
    } catch (e) {
      if (e instanceof WorkerFailure) {
        respond(frame.id, { ok: false, error: e.detail });
      } else {
        // An unexpected throw is still a typed failure to the caller — never a silent hang and
        // never a raw stack trace, which could contain host paths.
        respond(frame.id, {
          ok: false,
          error: { category: 'internal', message: e instanceof Error ? e.message : String(e) },
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function respond(id: string, response: WorkerResponse): void {
  process.stdout.write(JSON.stringify({ id, body: { kind: 'response', response } }) + '\n');
}

main().catch((e: unknown) => {
  process.stderr.write(`tool-worker fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
