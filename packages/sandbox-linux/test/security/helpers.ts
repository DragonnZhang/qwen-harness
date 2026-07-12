/**
 * Shared scaffolding for the security suite. These tests run REAL bubblewrap and REALLY try to
 * escape it. A helper that faked anything would defeat the entire point, so this file only builds
 * disposable workspaces and specs — every assertion is on real process behavior.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCapability } from '../../src/capability.ts';
import { SANDBOX_SCRATCH, SANDBOX_WORKSPACE } from '../../src/bwrap.ts';
import type { SandboxSpec, IsolationMode, ResourceLimits } from '../../src/spec.ts';

export const CAP = detectCapability();
export const SH = '/usr/bin/sh';
export const NODE = '/usr/bin/node';

let counter = 0;

export interface Workspace {
  readonly root: string;
  readonly workspace: string;
  readonly scratch: string;
  cleanup(): void;
}

export function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), `qh-sec-${process.pid}-${counter++}-`));
  const workspace = join(root, 'workspace');
  const scratch = join(root, 'scratch');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  return {
    root,
    workspace,
    scratch,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface SpecOptions {
  mode?: IsolationMode;
  networkAllowed?: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  limits?: ResourceLimits;
  signal?: AbortSignal;
  /**
   * Override the cwd. Inside bwrap the default is the internal mount alias; a run against the
   * DISABLED backend executes on the host and must use a real host directory instead.
   */
  cwd?: string;
}

/** Build a spec whose cwd is the internal workspace mountpoint (or an override). */
export function specFor(ws: Workspace, options: SpecOptions): SandboxSpec {
  return {
    isolation: {
      mode: options.mode ?? 'workspace-write',
      workspaceRoot: ws.workspace,
      scratchRoot: ws.scratch,
      networkAllowed: options.networkAllowed ?? false,
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
    },
    command: options.command,
    args: options.args,
    cwd: options.cwd ?? SANDBOX_WORKSPACE,
    env: options.env ?? { PATH: '/usr/bin:/bin' },
    timeoutMs: options.timeoutMs ?? 15_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

export { SANDBOX_WORKSPACE, SANDBOX_SCRATCH };
