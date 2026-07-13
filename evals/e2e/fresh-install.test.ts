/**
 * GOLDEN PATH 10 — Fresh install, end to end.
 *
 *   "a clean clone on the recorded Linux target bootstraps, checks, builds, starts, completes a
 *    deterministic task, exports the session, and uninstalls without residue outside documented
 *    state."  (capability-matrix.md, path 10)
 *
 * This assembles the whole path as one reproducible test. The packaging machinery it drives is not
 * built here — it is the SAME real tooling checkpoint 09 hardened: `scripts/package-cli.ts` builds
 * the versioned tarball, `packaging/install.sh` installs / uninstalls it into a throwaway prefix.
 * `packaging/test/lifecycle.test.ts` already proves install → run(help/doctor) → upgrade → rollback
 * → uninstall in isolation; this test does NOT duplicate that. It proves the MISSING piece: the full
 * arc tied together — build, install, complete a deterministic coding task in a real workspace, then
 * EXPORT that session THROUGH THE INSTALLED BINARY and prove the JSONL is well-formed and secret
 * free, then uninstall with no residue.
 *
 * What is executed for real, and by which binary — stated plainly, because a fresh-install claim is
 * worthless if it is quietly a mock:
 *
 *   build      — the REAL `scripts/package-cli.ts` (tsc + esbuild + vendored native addon).
 *   install    — the REAL `packaging/install.sh`, sha256-verifying into a temp prefix.
 *   help       — the REAL INSTALLED bundle (`$PREFIX/bin/qwen-harness`) executes.
 *   coding task— the REAL CLI `main()` (same entry `bin.ts` calls), running as a separate process,
 *                driving the REAL tool pipeline / policy / storage against a throwaway git workspace.
 *                The edit really lands on disk. The ONE substitution is the model: a scripted,
 *                deterministic provider is injected, exactly the hermetic path the other e2e tests
 *                (`cli-run`, approval-resume) use. See the LIMITATION note below for why this cannot
 *                run through the installed bundle itself.
 *   sessions   — the REAL INSTALLED bundle lists the session the run persisted (cross-process read).
 *   export     — the REAL INSTALLED bundle emits the session as JSONL.
 *   uninstall  — the REAL `packaging/install.sh`, then a full inventory of the prefix.
 *
 * LIMITATION (reported, not papered over): the shipped bundle wires `new DashScopeProvider()` with
 * no options (apps/cli/src/wiring.ts) and the provider hard-codes the real DashScope base URL
 * (DASHSCOPE_DEFAULTS.baseURL) — the config's `baseUrl` is loaded and shown by `doctor` but is never
 * plumbed into the provider. So the INSTALLED binary's `run` can only reach the live model over the
 * network; there is no in-bundle hook to point it at a local fake or inject a scripted provider.
 * Driving the deterministic coding turn therefore goes through the CLI's real `main()` from source
 * with the provider injected — the identical composition the installed bundle contains, minus the
 * esbuild step and with the model swapped. Everything downstream of that turn (the durable session,
 * the export, the redaction) is exercised through the actually-installed binary. Making the coding
 * turn itself run through the installed bundle deterministically would require plumbing config.baseUrl
 * into the provider, which lives outside this test's lane (apps/**).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderStreamEvent } from '@qwen-harness/provider-core';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'packaging', 'install.sh');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
/** The REAL CLI `main()`, invoked as a process, with only the model replaced by a JSON script. */
const SCRIPTED_CLI = join(REPO_ROOT, 'apps', 'cli', 'test', 'fixtures', 'scripted-cli.ts');

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Run {
  const r = spawnSync(cmd, [...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Every path under `dir`, so "uninstall left nothing behind" is a comparison, not a vibe. */
function inventory(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, base: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      out.push(full.slice(base.length + 1));
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false; // a dangling symlink: record it, do not descend
      }
      if (isDir) walk(full, base);
    }
  };
  if (existsSync(dir)) walk(dir, dir);
  return out.sort();
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ProviderStreamEvent {
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: name,
    argumentsJson: JSON.stringify(args),
    arguments: args,
  };
}

const client = new ToolWorkerClient();

let work: string;
let prefix: string;
let home: string;
let workspace: string;
let bin: string;
let tarball: string;
let version: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'qh-fresh-install-'));
  prefix = join(work, 'prefix');
  home = join(work, 'home'); // a hermetic HOME: nothing touches the real ~/.config
  workspace = join(work, 'workspace');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(join(home, '.config'), { recursive: true });
  mkdirSync(workspace, { recursive: true });

  // 1. BUILD the real artifact. `--allow-dirty` because a dev tree (and CI mid-branch) is usually
  //    dirty; the manifest records that, and the fresh-install arc does not depend on it.
  const built = run('pnpm', ['exec', 'tsx', 'scripts/package-cli.ts', '--allow-dirty']);
  if (built.code !== 0) {
    throw new Error(`packaging failed:\n${built.stdout}\n${built.stderr}`);
  }
  version = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;
  tarball = join(REPO_ROOT, 'dist', 'release', `qwen-harness-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`expected tarball ${tarball} was not produced`);

  // 2. INSTALL into the fresh prefix, into a hermetic HOME so config migration cannot touch the
  //    real user config.
  const installed = run('bash', [INSTALL_SH, 'install', tarball, '--prefix', prefix], {
    env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
  });
  if (installed.code !== 0) {
    throw new Error(`install failed:\n${installed.stdout}\n${installed.stderr}`);
  }
  bin = join(prefix, 'bin', 'qwen-harness');
  if (!existsSync(bin)) throw new Error('installer did not create bin/qwen-harness');

  // 3. A throwaway git workspace: a buggy `add` (it subtracts) and a test that fails until fixed.
  //    A `.env` carries a PLANTED secret — the testkit canary, byte-for-byte as realistic as a live
  //    key — so that when the agent reads it, a secret enters the durable session and the export
  //    MUST scrub it. The env var of the same name seeds the store's redactor at write time.
  writeFileSync(join(workspace, 'add.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
  writeFileSync(
    join(workspace, 'add.test.mjs'),
    "import assert from 'node:assert';\n" +
      "import { add } from './add.mjs';\n" +
      'assert.equal(add(2, 3), 5);\n' +
      "console.log('PASS');\n",
  );
  writeFileSync(join(workspace, '.env'), `DASHSCOPE_API_KEY=${CANARY_API_KEY}\n`);
  const git = (args: readonly string[]): void =>
    void execFileSync('git', [...args], { cwd: workspace });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}, 300_000);

afterAll(() => {
  // Best-effort: uninstall may already have run. Then remove the entire throwaway tree — the only
  // state this test created outside it is `dist/release/`, a build artifact the packaging suite owns.
  try {
    run('bash', [INSTALL_SH, 'uninstall', '--prefix', prefix], { env: { HOME: home } });
  } catch {
    // ignore — the residue assertion, if reached, is the real check
  }
  rmSync(work, { recursive: true, force: true });
});

describe('golden path 10 — fresh install, build → run → export → uninstall', () => {
  it('the sandbox is available — the deterministic task runs through the real pipeline', () => {
    expect(client.detect().available, client.detect().detail).toBe(true);
  });

  it('the build produced a versioned, self-contained tarball', () => {
    const listing = run('tar', ['-tzf', tarball]).stdout;
    for (const entry of [
      'package/bin/qwen-harness',
      'package/lib/cli.js',
      'package/SHA256SUMS',
      'package/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ]) {
      expect(listing, `expected ${entry} in the package`).toContain(entry);
    }
  });

  it('the INSTALLED binary starts — the bundle is not just present, it runs', () => {
    const help = run(bin, ['help'], { cwd: workspace, env: { HOME: home } });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('qwen-harness <command>');
    expect(help.stdout).toContain('export <id>');
  });

  // Shared across the ordered assertions below (the same pattern lifecycle.test.ts uses).
  let threadId = '';
  let exported = '';

  it('completes a deterministic coding task and the edit really lands on disk', () => {
    // The scripted model: inspect the failing test's config (the .env, which holds the secret),
    // read the buggy source, fix subtraction → addition, run the now-passing test, then conclude.
    const script: ProviderStreamEvent[][] = [
      [
        toolCall('call_env001', 'read_file', { path: '.env' }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        toolCall('call_src001', 'read_file', { path: 'add.mjs' }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        toolCall('call_edit01', 'edit_file', {
          path: 'add.mjs',
          oldText: 'a - b',
          newText: 'a + b',
        }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        toolCall('call_shel01', 'run_shell', {
          command: '/usr/bin/env',
          argv: ['node', 'add.test.mjs'],
          cwd: '.',
        }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-done', itemId: 'm', text: 'Fixed the add bug; the test passes now.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ];
    const scriptPath = join(workspace, 'model-script.json');
    writeFileSync(scriptPath, JSON.stringify(script));

    // A separate process running the REAL CLI main(). `DASHSCOPE_API_KEY` is the planted canary so
    // the store's redactor is seeded with the live secret value at write time.
    const result = run(
      TSX,
      [SCRIPTED_CLI, 'run', '--profile', 'yolo', 'fix the failing add test'],
      {
        cwd: workspace,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          DASHSCOPE_API_KEY: CANARY_API_KEY,
          QH_SCRIPT: scriptPath,
        },
      },
    );

    expect(result.code, `run stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('the test passes');
    expect(result.stderr).toContain('[completed:');

    // The fix really landed in the real workspace, and the test really passes now.
    expect(readFileSync(join(workspace, 'add.mjs'), 'utf8')).toContain('a + b');
    const testOut = execFileSync('/usr/bin/env', ['node', 'add.test.mjs'], {
      cwd: workspace,
      encoding: 'utf8',
    });
    expect(testOut).toContain('PASS');

    // The run created a durable session under the workspace — this is what the installed binary
    // will read back.
    expect(existsSync(join(workspace, '.qwen-harness', 'sessions.sqlite'))).toBe(true);
    const match = /session (thr_[a-z0-9]+)/.exec(result.stderr);
    expect(match, 'the run must report a session id').not.toBeNull();
    threadId = match![1]!;
  }, 180_000);

  it('the INSTALLED binary lists the session the run persisted (cross-process store read)', () => {
    const sessions = run(bin, ['sessions'], { cwd: workspace, env: { HOME: home } });
    expect(sessions.code).toBe(0);
    expect(sessions.stdout, sessions.stderr).toContain(threadId);
    expect(sessions.stdout).toContain('turns=1');
  });

  it('the INSTALLED binary exports the session as well-formed JSONL', () => {
    const result = run(bin, ['export', threadId], { cwd: workspace, env: { HOME: home } });
    expect(result.code, result.stderr).toBe(0);
    exported = result.stdout;

    const lines = exported.split('\n').filter((l) => l.trim().length > 0);
    // Line 1 is the stable public header; every following line is one typed event.
    const header = JSON.parse(lines[0]!) as {
      format: string;
      formatVersion: number;
      threadId: string;
      eventCount: number;
    };
    expect(header.format).toBe('qwen-harness/jsonl');
    expect(header.formatVersion).toBe(1);
    expect(header.threadId).toBe(threadId);
    expect(header.eventCount).toBeGreaterThan(0);

    const events = lines.slice(1).map((l) => JSON.parse(l) as { payload?: { type?: string } });
    // Every event line parses, and the count matches what the header promised — a truncated or
    // malformed export fails here rather than downstream.
    expect(events.length).toBe(header.eventCount);
    expect(events[0]?.payload?.type).toBe('thread-created');
    // The coding turn is actually in the export, so "no secret" below is not trivially true because
    // the session was empty.
    expect(events.some((e) => e.payload?.type === 'item-appended')).toBe(true);
    expect(exported).toContain('add.mjs');
  });

  it('the exported session is secret-free — the planted canary was scrubbed, not shipped', () => {
    // Proof the redaction path was actually exercised: the agent read the .env, so the secret DID
    // enter a persisted tool result — and the export shows it redacted, not raw.
    expect(exported).toContain('[REDACTED]');
    // The literal canary value never appears — not raw, not in its recognizable shape.
    expect(exported.includes(CANARY_API_KEY)).toBe(false);
    expect(/sk-canary[A-Za-z0-9]/.test(exported)).toBe(false);
    // And the raw bytes on the wire agree with the string check (grep the export, not a parsed view).
    expect(Buffer.from(exported, 'utf8').includes(Buffer.from(CANARY_API_KEY, 'utf8'))).toBe(false);
  });

  it('uninstall leaves the prefix with no residue outside documented state', () => {
    const r = run('bash', [INSTALL_SH, 'uninstall', '--prefix', prefix], { env: { HOME: home } });
    expect(r.code).toBe(0);
    // The user config is documented, owned state: the installer must NOT remove it.
    expect(r.stdout + r.stderr).toContain('config');

    // The install prefix is left byte-empty — no stray binary, lib, version, or completion.
    const left = inventory(prefix);
    expect(left, `these paths survived uninstall: ${left.join(', ')}`).toEqual([]);
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(join(prefix, 'lib', 'qwen-harness'))).toBe(false);

    // The only other state the arc created lives inside the throwaway workspace: the per-workspace
    // `.qwen-harness/` session store — documented workspace state, and disposed with the temp tree.
    expect(existsSync(join(workspace, '.qwen-harness'))).toBe(true);
  });
});
