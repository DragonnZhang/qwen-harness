import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProviderStreamEvent } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadHooks } from '../../src/hooks.ts';

/**
 * Hooks, on the REAL turn (HK-01..HK-05).
 *
 * The hook engine was complete and unreachable: no config key existed and no application ever fired
 * an event. These tests drive the real CLI in a real second process, with a real hook file declaring
 * a real command handler that runs as a real child process, and assert on what the hook DID to the
 * turn — not on what the engine would have returned if someone had called it.
 *
 * The load-bearing assertion is the negative one: when a PreToolUse hook blocks, the tool must not
 * have run. A hook that is "wired" but whose verdict the executor ignores is precisely the kind of
 * security theatre this repository is not allowed to ship.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const FIXTURE = join(REPO, 'apps', 'cli', 'test', 'fixtures', 'scripted-cli.ts');

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  workspace: string,
  home: string,
  scriptPath: string,
  args: readonly string[],
): Promise<RunResult> {
  const child = spawn(TSX, [FIXTURE, ...args], {
    cwd: workspace,
    // A home of its OWN. Pointing HOME at the workspace would make the user-scope and project-scope
    // hook files the same path, which is a different scenario than the one under test.
    env: { ...process.env, QH_SCRIPT: scriptPath, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  child.stdin?.end();
  return new Promise((res) =>
    child.on('exit', (code) => res({ code: code ?? -1, stdout, stderr })),
  );
}

function openStore(workspace: string): EventStore {
  return new EventStore({
    path: join(workspace, '.qwen-harness', 'sessions.sqlite'),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
    ids: new SequentialIds(),
  });
}

/** A hook handler as a real executable that prints a typed outcome on stdout. */
function writeHookScript(path: string, outcome: unknown): void {
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nexec echo '${JSON.stringify(outcome)}'\n`);
  chmodSync(path, 0o755);
}

describe('a PreToolUse hook can block a tool on the real turn', () => {
  let workspace: string;
  let home: string;
  let scriptPath: string;
  const markerRel = 'tool-ran.marker';

  const shellArgs = {
    command: '/usr/bin/env',
    argv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(markerRel)}, 'ran');`],
    cwd: '.',
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-hooks-'));
    home = mkdtempSync(join(tmpdir(), 'qh-hookhome-'));
    mkdirSync(join(workspace, '.qwen-harness'), { recursive: true });

    const script: ProviderStreamEvent[][] = [
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_1',
          toolName: 'run_shell',
          argumentsJson: JSON.stringify(shellArgs),
          arguments: shellArgs,
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'it_2', text: 'I could not run that.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ];
    scriptPath = join(workspace, 'script.json');
    writeFileSync(scriptPath, JSON.stringify(script));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('blocks it: the shell command never runs, and the block is in the audit log', async () => {
    const hookScript = join(workspace, 'deny.sh');
    writeHookScript(hookScript, {
      type: 'block',
      reason: { code: 'no-shell', message: 'shell is forbidden in this repository' },
    });

    writeFileSync(
      join(workspace, '.qwen-harness', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: [
          {
            id: 'no-shell',
            event: 'PreToolUse',
            matcher: { toolName: 'run_shell' },
            handler: { type: 'command', command: hookScript },
          },
        ],
      }),
    );

    const result = await runCli(workspace, home, scriptPath, [
      'run',
      '--profile',
      'yolo',
      'run a shell',
    ]);
    expect(result.code, result.stderr).toBe(0);

    // THE ASSERTION. The tool did not run. Under `yolo` policy would have allowed it outright — the
    // ONLY thing that stopped it is the hook.
    expect(existsSync(join(workspace, markerRel))).toBe(false);

    // ...and the block is durable, attributed, and auditable.
    const store = openStore(workspace);
    try {
      const events = store.readAll().map((e) => e.payload);
      const fired = events.filter((p) => p.type === 'hook-fired');
      expect(fired.length).toBeGreaterThan(0);
      expect(
        fired.some((p) => p.type === 'hook-fired' && p.outcome === 'block'),
        'the PreToolUse block must be recorded as a durable hook-fired event',
      ).toBe(true);
      expect(
        fired.some((p) => p.type === 'hook-fired' && p.handler === 'project:no-shell'),
        'the hook must be attributed to the handler that produced it',
      ).toBe(true);

      // The side effect never even reached execution.
      expect(events.some((p) => p.type === 'side-effect-started')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('a hook that says `allow` cannot make an unrunnable turn run a denied tool (HK-04)', async () => {
    // The no-elevation invariant, from the outside. `plan` is the profile in which a shell is simply
    // not available; a PreToolUse hook returning `allow` must not resurrect it. The engine reads only
    // `blocked` from a hook, and policy still refuses.
    const hookScript = join(workspace, 'allow.sh');
    writeHookScript(hookScript, {
      type: 'allow',
      reason: { code: 'hook', message: 'I say this is fine' },
    });

    writeFileSync(
      join(workspace, '.qwen-harness', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: [
          {
            id: 'yes-please',
            event: 'PreToolUse',
            handler: { type: 'command', command: hookScript },
          },
        ],
      }),
    );

    const result = await runCli(workspace, home, scriptPath, [
      'run',
      '--profile',
      'plan',
      '--json',
      'run a shell',
    ]);

    // The tool did NOT run, whatever the hook said.
    expect(existsSync(join(workspace, markerRel))).toBe(false);
    expect(result.code, result.stderr).toBe(0);

    const store = openStore(workspace);
    try {
      const events = store.readAll().map((e) => e.payload);
      // Policy — not the hook — had the last word.
      const denied = events.filter((p) => p.type === 'policy-decision' && p.decision !== 'allow');
      expect(denied.length, 'policy must still refuse the shell under `plan`').toBeGreaterThan(0);
      expect(events.some((p) => p.type === 'side-effect-started')).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('hook configuration is validated, never silently ignored', () => {
  let workspace: string;
  let home: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-hookcfg-'));
    home = mkdtempSync(join(tmpdir(), 'qh-hookcfghome-'));
    mkdirSync(join(workspace, '.qwen-harness'), { recursive: true });
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const write = (doc: unknown) =>
    writeFileSync(join(workspace, '.qwen-harness', 'hooks.json'), JSON.stringify(doc));

  it('an absent file contributes nothing', () => {
    expect(loadHooks({ workspaceRoot: workspace, homeDir: home }).registrations).toEqual([]);
  });

  it('an unknown hook event is REJECTED, not dropped', () => {
    write({
      hooks: [{ id: 'x', event: 'NotAnEvent', handler: { type: 'command', command: 'x' } }],
    });
    expect(() => loadHooks({ workspaceRoot: workspace, homeDir: home })).toThrow(
      /not a known hook event/,
    );
  });

  it('an `http` handler is REJECTED rather than accepted and never run', () => {
    // The honest failure. Accepting the key and silently not running the hook is the one behaviour
    // that would let a user believe a security hook was in place when it was not.
    write({
      hooks: [{ id: 'x', event: 'PreToolUse', handler: { type: 'http', url: 'https://x.test' } }],
    });
    expect(() => loadHooks({ workspaceRoot: workspace, homeDir: home })).toThrow();
  });

  it('a malformed file fails loudly (it does not degrade into "no hooks")', () => {
    writeFileSync(join(workspace, '.qwen-harness', 'hooks.json'), '{ not json');
    expect(() => loadHooks({ workspaceRoot: workspace, homeDir: home })).toThrow(/not valid JSON/);
  });

  it('a project hook is namespaced by scope so it cannot displace a managed one', () => {
    write({
      hooks: [
        { id: 'audit', event: 'PreToolUse', handler: { type: 'command', command: '/bin/x' } },
      ],
    });
    const loaded = loadHooks({ workspaceRoot: workspace, homeDir: home });
    expect(loaded.registrations[0]!.id).toBe('project:audit');
  });
});
