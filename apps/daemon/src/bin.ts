#!/usr/bin/env node
/**
 * The daemon executable.
 *
 * Thin: it adapts the process to `Daemon.start`. The interesting behavior — and the one this binary
 * exists to make observable — is that a SECOND daemon started against a live lease refuses to run.
 * It exits 3 and says who holds the lease, rather than opening a second writer on the same store.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { loadRunAuthority } from '@qwen-harness/cli';
import { resolveProfile } from '@qwen-harness/protocol';

import { Daemon } from './daemon.ts';
import { LeaseError } from './lease.ts';

interface Args {
  readonly socket: string;
  readonly lease: string;
  readonly state: string;
  readonly workspace: string;
  readonly profile: string;
  readonly model: string;
}

function parseArgs(argv: readonly string[]): Partial<Args> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i++;
    }
  }
  return out as Partial<Args>;
}

let counter = 0;
const ids = {
  next(prefix: string): string {
    counter += 1;
    return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}`;
  },
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolve(args.workspace ?? process.cwd());
  const socketPath = args.socket ?? resolve(workspace, '.qwen-harness', 'daemon.sock');
  const leasePath = args.lease ?? resolve(workspace, '.qwen-harness', 'daemon.lease');
  const statePath = args.state ?? resolve(workspace, '.qwen-harness', 'sessions.sqlite');
  // The daemon loads configuration and derives its ceiling exactly as the CLI does. It runs the
  // same turns under the same authority; an operator's managed policy binds it identically.
  const cliOverrides: Record<string, unknown> = {};
  if (args.profile !== undefined) {
    const requested = resolveProfile(args.profile);
    if (requested === undefined) {
      process.stderr.write(`daemon: unknown profile "${args.profile}"\n`);
      return 1;
    }
    cliOverrides['permissionProfile'] = requested;
  }
  if (args.model !== undefined) cliOverrides['model'] = args.model;

  let authority;
  try {
    authority = loadRunAuthority({
      projectRoot: workspace,
      homeDir: homedir(),
      env: process.env,
      cli: cliOverrides,
    });
  } catch (err) {
    process.stderr.write(`daemon: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let daemon;
  try {
    daemon = await Daemon.start({
      socketPath,
      leasePath,
      statePath,
      workspaceRoot: workspace,
      homeDir: homedir(),
      authority,
      model: authority.config.model.value,
      instructions: '',
      clock: { now: () => Date.now() },
      ids,
      log: (line) => process.stdout.write(line + '\n'),
    });
  } catch (e) {
    if (e instanceof LeaseError && e.code === 'held') {
      // Exactly one writer. The second daemon does not "win a race" or "retry later" — it refuses,
      // and tells you where the live one is, so clients attach to it instead (SS-08).
      process.stderr.write(`daemon: ${e.message}; attach to it instead of starting a second one\n`);
      return 3;
    }
    process.stderr.write(`daemon: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise<number>(() => {
    // Run until signalled.
  });
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
