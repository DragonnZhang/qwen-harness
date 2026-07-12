/**
 * Test-only constructors. Outside `src/`, so they are never compiled into `dist` and never become
 * part of the package's public API.
 *
 * Nothing here fakes a decision: every helper builds a REAL NormalizedAction and a REAL
 * PolicyContext and hands them to the real engine.
 */

import { createHash } from 'node:crypto';

import type { Actor, ActorId, PermissionProfile } from '@qwen-harness/protocol';

import type { NormalizedAction } from '../src/action.ts';
import type { PolicyContext } from '../src/engine.ts';
import type { Grant } from '../src/grants.ts';
import type { ManagedPolicy } from '../src/managed.ts';
import { NO_MANAGED_RESTRICTIONS } from '../src/managed.ts';
import type { PolicyRule } from '../src/rules.ts';

export const WORKSPACE = '/home/dev/project';
export const HOME = '/home/dev';
export const NOW = 1_700_000_000_000;

export const MODEL: Actor = { kind: 'model', id: 'act_model1' as ActorId };
export const USER: Actor = { kind: 'user', id: 'act_user01' as ActorId };
export const SUBAGENT: Actor = { kind: 'subagent', id: 'act_sub001' as ActorId };

export function digestOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ContextOverrides {
  profile?: PermissionProfile;
  managedPolicy?: ManagedPolicy;
  rules?: readonly PolicyRule[];
  grants?: readonly Grant[];
  workspaceRoot?: string;
  homeDir?: string;
  now?: number;
  actor?: Actor;
  hookOutcome?: PolicyContext['hookOutcome'];
}

export function ctx(overrides: ContextOverrides = {}): PolicyContext {
  return {
    profile: overrides.profile ?? 'ask',
    managedPolicy: overrides.managedPolicy ?? NO_MANAGED_RESTRICTIONS,
    rules: overrides.rules ?? [],
    grants: overrides.grants ?? [],
    workspaceRoot: overrides.workspaceRoot ?? WORKSPACE,
    homeDir: overrides.homeDir ?? HOME,
    now: overrides.now ?? NOW,
    actor: overrides.actor ?? MODEL,
    hookOutcome: overrides.hookOutcome,
  };
}

// --- action constructors ----------------------------------------------------------------------

export const fileRead = (path: string): NormalizedAction => ({ kind: 'file-read', path });

export const fileWrite = (
  path: string,
  content = 'hello',
  executable = false,
): NormalizedAction => ({
  kind: 'file-write',
  path,
  createsExecutable: executable,
  contentDigest: digestOf(content),
});

export const fileEdit = (path: string, edits = 'e1', executable = false): NormalizedAction => ({
  kind: 'file-edit',
  path,
  createsExecutable: executable,
  editsDigest: digestOf(edits),
});

export const patch = (paths: string[], body = 'diff'): NormalizedAction => ({
  kind: 'patch',
  paths,
  createsExecutable: false,
  patchDigest: digestOf(body),
});

export const shell = (command: string, cwd = WORKSPACE): NormalizedAction => ({
  kind: 'shell',
  command,
  argv: command.split(' '),
  cwd,
});

export const gitRead = (): NormalizedAction => ({
  kind: 'git-read',
  repoRoot: WORKSPACE,
  operation: 'status',
});

export const gitWrite = (operation = 'commit', destructive = false): NormalizedAction => ({
  kind: 'git-write',
  repoRoot: WORKSPACE,
  operation,
  destructive,
  argv: ['git', operation],
});

export const network = (url = 'https://example.com/x', host = 'example.com'): NormalizedAction => ({
  kind: 'network',
  method: 'GET',
  url,
  host,
  port: 443,
  scheme: 'https',
});

export const mcp = (sideEffect: boolean, tool = 'create_issue'): NormalizedAction => ({
  kind: 'mcp',
  server: 'github',
  tool,
  sideEffect,
  argumentsDigest: digestOf(tool),
});

export function grant(overrides: Partial<Grant> & Pick<Grant, 'id' | 'scope'>): Grant {
  return {
    actionDigest: null,
    match: null,
    grantedAt: NOW,
    expiresAt: null,
    revokedAt: null,
    usedAt: null,
    grantedBy: 'act_user01',
    reason: 'approved in a test',
    ...overrides,
  };
}

/**
 * A seeded LCG. Property tests must be reproducible: a failure that only happens on some runs is a
 * failure nobody can debug.
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return this.#state / 0x1_0000_0000;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  bool(): boolean {
    return this.next() < 0.5;
  }
}
