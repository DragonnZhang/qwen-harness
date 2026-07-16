import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../../src/doctor.ts';

/**
 * `doctor` reports each scheduling backend's explicit availability (CR-06). The availability function
 * is genuinely WIRED — this drives the real report and asserts the backends and their signals appear,
 * so the abstraction cannot rot into a loaded-but-unused export.
 */

describe('doctor reports scheduling-backend availability (CR-06)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qh-doctor-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const report = (env: Record<string, string | undefined>) =>
    runDoctor({ projectRoot: root, env, homeDir: root }).lines.join('\n');

  it('with no daemon and no remote, only the session scheduler shows available', () => {
    const out = report({});
    expect(out).toContain('scheduling backends:');
    expect(out).toMatch(/✓ session-scheduler/);
    expect(out).toMatch(/· local-daemon: unavailable/);
    expect(out).toMatch(/· remote-routine-peer: unavailable/);
  });

  it('a daemon lease file makes the local-daemon backend show available', () => {
    mkdirSync(join(root, '.qwen-harness'), { recursive: true });
    writeFileSync(join(root, '.qwen-harness', 'daemon.lease'), '4242', 'utf8');
    expect(report({})).toMatch(/✓ local-daemon/);
  });

  it('a configured remote peer makes the remote backend show available', () => {
    const out = report({ QWEN_HARNESS_REMOTE_PEER: 'wss://peer.example/agent' });
    expect(out).toMatch(/✓ remote-routine-peer: configured: wss:\/\/peer\.example\/agent/);
  });
});
