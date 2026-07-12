/**
 * Integration: REAL command hooks. These spawn actual child processes via the controlled executor
 * and prove the out-of-process path end to end — stdout JSON parsing, the enforced deadline that
 * cancels a hook which sleeps too long, and process cleanup.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SystemClock } from '@qwen-harness/hooks';
import { CommandExecutor, HookEngine, HookRegistry } from '@qwen-harness/hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;

function writeScript(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qwen-hook-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEngine(): { engine: HookEngine; registry: HookRegistry } {
  const registry = new HookRegistry();
  const engine = new HookEngine({
    registry,
    clock: new SystemClock(),
    commandExecutor: new CommandExecutor({ baseEnv: { PATH: process.env['PATH'] } }),
    defaultTimeoutMs: 5_000,
  });
  return { engine, registry };
}

describe('real command hook (HK-02, HK-03)', () => {
  it('returns a block outcome via stdout JSON', async () => {
    const script = writeScript(
      'block.sh',
      '#!/bin/sh\ncat >/dev/null\nprintf \'{"type":"block","reason":{"code":"policy","message":"denied by hook"}}\'\n',
    );
    const { engine, registry } = makeEngine();
    registry.register({
      id: 'blocker',
      event: 'PreToolUse',
      handler: { kind: 'command', command: script },
    });
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    expect(res.blocked).toBe(true);
    expect(res.blockReason?.hookId).toBe('blocker');
    expect(res.blockReason?.reason.message).toBe('denied by hook');
    expect(res.decision).toBe('deny');
    expect(res.failures).toHaveLength(0);
  });

  it('parses a modify outcome and flags it for revalidation', async () => {
    const script = writeScript(
      'modify.sh',
      '#!/bin/sh\ncat >/dev/null\nprintf \'{"type":"modify","toolInput":{"command":"ls -a"}}\'\n',
    );
    const { engine, registry } = makeEngine();
    registry.register({
      id: 'm',
      event: 'PreToolUse',
      handler: { kind: 'command', command: script },
    });
    const res = await engine.run(
      'PreToolUse',
      { toolName: 'Bash', toolInput: { command: 'ls' } },
      { currentDecision: 'ask' },
    );
    expect(res.modifiedInput?.needsRevalidation).toBe(true);
    expect(res.modifiedInput?.toolInput).toEqual({ command: 'ls -a' });
  });

  it('enforces a timeout: a hook that sleeps too long is cancelled', async () => {
    const script = writeScript('slow.sh', '#!/bin/sh\nsleep 30\nprintf \'{"type":"continue"}\'\n');
    const { engine, registry } = makeEngine();
    registry.register({
      id: 'slow',
      event: 'PreToolUse',
      handler: { kind: 'command', command: script, timeoutMs: 300 },
    });
    const started = Date.now();
    const res = await engine.run('PreToolUse', { toolName: 'Bash' }, { currentDecision: 'ask' });
    const elapsed = Date.now() - started;
    // The 30s sleep must NOT have run to completion; the 300ms deadline cancelled it.
    expect(elapsed).toBeLessThan(5_000);
    expect(res.failures[0]?.kind).toBe('timeout');
    // A cancelled hook does not silently allow.
    expect(res.decision).toBe('ask');
  });

  it('an empty exit-0 hook is a no-op continue', async () => {
    const script = writeScript('noop.sh', '#!/bin/sh\ncat >/dev/null\nexit 0\n');
    const { engine, registry } = makeEngine();
    registry.register({
      id: 'noop',
      event: 'PostToolUse',
      handler: { kind: 'command', command: script },
    });
    const res = await engine.run('PostToolUse', { toolName: 'Bash' }, { currentDecision: 'allow' });
    expect(res.failures).toHaveLength(0);
    expect(res.decision).toBe('allow');
    expect(res.audit[0]?.outcome).toBe('continue');
  });
});
