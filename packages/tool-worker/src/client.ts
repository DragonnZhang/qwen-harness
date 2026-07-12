import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessError, type IsolationMode } from '@qwen-harness/protocol';
import {
  BubblewrapBackend,
  SANDBOX_SCRATCH,
  SANDBOX_WORKSPACE,
  minimizeEnv,
  type SandboxBackend,
  type SandboxSpec,
} from '@qwen-harness/sandbox-linux';

import {
  WorkerResponseSchema,
  type WorkerGrant,
  type WorkerRequest,
  type WorkerResponse,
} from './rpc.ts';

/**
 * The tool-worker CLIENT. Runs in the main runtime process, but performs NO tool I/O itself — it
 * spawns a sandboxed worker for each request and speaks the capability-scoped RPC.
 *
 * One fresh sandboxed process PER tool call. That is the strongest isolation available: no state
 * survives between calls, so a compromise in one tool execution cannot bleed into the next. The
 * per-call spawn cost is real but small next to a model round, and safety wins that trade.
 */

export interface ToolWorkerClientOptions {
  /** The sandbox backend. Injected so tests can assert on the spec; defaults to bubblewrap. */
  readonly backend?: SandboxBackend;
  /** Absolute path to the built worker entry (dist/worker-entry.js). Resolved by default. */
  readonly workerEntry?: string;
  /** Absolute path to the node binary to run the worker. Defaults to the current one. */
  readonly nodePath?: string;
}

export interface RunToolOptions {
  /** Canonical absolute workspace root on the host. */
  readonly workspaceRoot: string;
  readonly isolation: IsolationMode;
  readonly grant: WorkerGrant;
  readonly request: WorkerRequest;
  readonly signal?: AbortSignal;
}

const DEFAULT_NODE = process.execPath;

function defaultWorkerEntry(): string {
  // The worker is a SELF-CONTAINED bundle (zod inlined). It has to be — inside the sandbox there
  // is no node_modules to import from, so a multi-file worker with external deps could not run.
  //
  // The bundle is produced in dist/ by the build. This file may run from either dist/ (production)
  // or src/ (tests, via the TS runner), so resolve to the dist bundle from whichever we are in.
  const here = fileURLToPath(new URL('.', import.meta.url));
  // Under the TS test runner `here` is .../src/; in production it is .../dist/. The bundle only
  // ever exists in dist/, so rewrite a trailing src segment to dist.
  const base = here.replace(new RegExp(`${sep}src${sep}?$`), `${sep}dist${sep}`);
  return join(base, 'worker.bundle.mjs');
}

export class ToolWorkerClient {
  readonly #backend: SandboxBackend;
  readonly #workerEntry: string;
  readonly #nodePath: string;

  constructor(options: ToolWorkerClientOptions = {}) {
    this.#backend = options.backend ?? new BubblewrapBackend();
    this.#workerEntry = options.workerEntry ?? defaultWorkerEntry();
    this.#nodePath = options.nodePath ?? DEFAULT_NODE;
  }

  detect() {
    return this.#backend.detect();
  }

  /**
   * Runs one tool request in a fresh sandboxed worker and returns its typed response.
   *
   * The request frame is written to a host scratch directory that is bound into the sandbox, and
   * the worker reads it from the sandbox-internal path. The response comes back on stdout. A file
   * (not argv/env) carries the request because a write's content can exceed ARG_MAX.
   */
  async run(opts: RunToolOptions): Promise<WorkerResponse> {
    // A private host scratch dir for this one call. Bound writable into the sandbox as
    // SANDBOX_SCRATCH, and removed afterwards so nothing leaks between calls.
    const hostScratch = mkdtempSync(join(tmpdir(), 'qh-rpc-'));
    const requestPath = join(hostScratch, 'request.json');

    try {
      const frame = {
        id: `rpc-${opts.request.op}`,
        body: { kind: 'request' as const, grant: opts.grant, request: opts.request },
      };
      writeFileSync(requestPath, JSON.stringify(frame), 'utf8');

      // Bind ONLY the single worker bundle file, read-only, at its own path. Not the whole dist
      // dir — the sandbox should see exactly one extra file beyond the workspace, scratch, and the
      // read-only OS. The model can execute it but can never modify it.
      const workerBundle = this.#workerEntry;

      const env = minimizeEnv(process.env, {
        overrides: {
          QH_REQUEST_FILE: join(SANDBOX_SCRATCH, 'request.json'),
          // The worker resolves capability handles against these sandbox-internal roots. It never
          // learns the host path — one less thing that can leak into a tool result.
          QH_WORKSPACE_ROOT: SANDBOX_WORKSPACE,
          QH_SCRATCH_ROOT: SANDBOX_SCRATCH,
          HOME: SANDBOX_SCRATCH,
        },
      });

      const spec: SandboxSpec = {
        isolation: {
          mode: opts.isolation,
          workspaceRoot: opts.workspaceRoot,
          scratchRoot: hostScratch,
          networkAllowed: opts.grant.network,
          extraBinds: [{ source: workerBundle, dest: workerBundle, mode: 'ro' }],
        },
        command: this.#nodePath,
        args: [this.#workerEntry],
        cwd: SANDBOX_WORKSPACE,
        env,
        timeoutMs: opts.grant.limits.wallMs,
        maxOutputBytes: opts.grant.limits.maxOutputBytes,
        ...(opts.signal ? { signal: opts.signal } : {}),
      };

      const result = await this.#backend.run(spec);

      // The worker writes exactly one response frame line to stdout. Find and parse it.
      const line = result.stdout.split('\n').find((l) => l.trim().length > 0);
      if (line === undefined) {
        throw harnessError({
          origin: 'sandbox',
          category: 'tool_worker.no_response',
          message: result.timedOut
            ? 'tool worker timed out before responding'
            : `tool worker produced no response (exit ${result.exitCode ?? 'null'}): ${result.stderr.slice(0, 500)}`,
        });
      }

      const parsed = JSON.parse(line) as { body?: { response?: unknown } };
      return WorkerResponseSchema.parse(parsed.body?.response);
    } finally {
      rmSync(hostScratch, { recursive: true, force: true });
    }
  }
}
