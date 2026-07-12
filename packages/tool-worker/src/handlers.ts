import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { constants as FS } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type {
  CapabilityHandle,
  ScopedPath,
  WorkerError,
  WorkerGrant,
  WorkerRequest,
} from './rpc.ts';

/**
 * The handlers. **This code runs ONLY inside the sandboxed worker process.**
 *
 * It is the sole place in the product where model-initiated filesystem, shell, and Git I/O
 * actually happens. Everything else — runtime, policy, provider, TUI — coordinates; this executes.
 */

/** Roots the sandbox bound, resolved once at worker startup. */
export type HandleRoots = Readonly<Record<CapabilityHandle, string>>;

export class WorkerFailure extends Error {
  constructor(readonly detail: WorkerError) {
    super(detail.message);
    this.name = 'WorkerFailure';
  }
}

const fail = (category: WorkerError['category'], message: string): never => {
  throw new WorkerFailure({ category, message });
};

// ---------------------------------------------------------------------------
// Path resolution — the security-critical part
// ---------------------------------------------------------------------------

/**
 * Resolves a `ScopedPath` to a real absolute path, or refuses.
 *
 * The checks, in order, and why each one exists:
 *
 * 1. **Reject an absolute `relative`.** `{handle: 'workspace', relative: '/etc/passwd'}` must not
 *    silently become `/etc/passwd`. `path.join` would happily produce it.
 * 2. **Normalize, then verify containment.** This catches `../../../etc/passwd` and its
 *    percent-encoded / dot-segment variants after normalization, not before.
 * 3. **Canonicalize through `realpathSync`** so a SYMLINK inside the workspace pointing at
 *    `/etc/passwd` resolves to its true target — and then re-verify containment. Checking the
 *    pre-resolution path is the classic symlink-escape bug.
 * 4. **Re-check after open (`fstat`), not before.** Between the containment check and the open, an
 *    attacker with write access to the workspace can swap a file for a symlink (TOCTOU). We open
 *    with `O_NOFOLLOW` where the target already exists, and confirm the opened file descriptor is
 *    the file we vetted by comparing device+inode.
 *
 * The sandbox already prevents the process from reaching outside its binds, so a bug here is not
 * catastrophic. But the sandbox is the boundary that must hold; this is the boundary that makes a
 * mistake *visible and testable* rather than relying on one control.
 */
export function resolveScoped(
  roots: HandleRoots,
  scoped: ScopedPath,
  opts: { mustExist: boolean },
): string {
  const root = roots[scoped.handle];
  if (root === undefined) fail('permission-denied', `no such capability handle: ${scoped.handle}`);

  // 1. An absolute path is never a valid *relative* path.
  if (isAbsolute(scoped.relative)) {
    fail('path-escape', `path must be relative to the ${scoped.handle} root: ${scoped.relative}`);
  }

  // 2. Normalize (NFC for Unicode homoglyph/decomposition tricks), then verify containment.
  const normalized = normalize(scoped.relative.normalize('NFC'));
  const candidate = resolve(root, normalized);
  assertContained(root, candidate, scoped.relative);

  // 3. Canonicalize symlinks in every existing parent, then re-verify.
  const canonical = canonicalizeExistingPrefix(candidate);
  assertContained(root, canonical, scoped.relative);

  if (opts.mustExist) {
    let fd: number | undefined;
    try {
      // O_NOFOLLOW: if the final component is a symlink, fail rather than follow it.
      fd = openSync(canonical, FS.O_RDONLY | FS.O_NOFOLLOW);
      const opened = fstatSync(fd);
      // 4. Confirm the fd we hold is the file we vetted — closes the TOCTOU window.
      const vetted = statSync(canonical);
      if (opened.dev !== vetted.dev || opened.ino !== vetted.ino) {
        fail('path-escape', 'file changed identity between check and open (TOCTOU)');
      }
      // A pre-existing hardlink to a file outside the workspace is indistinguishable from a
      // normal file by path alone. Safe profiles refuse them (defaults.md).
      if (opened.isFile() && opened.nlink > 1) {
        fail(
          'permission-denied',
          `refusing a hardlinked file (nlink=${opened.nlink}): ${scoped.relative}`,
        );
      }
    } catch (e) {
      if (e instanceof WorkerFailure) throw e;
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ELOOP')
        fail('path-escape', `refusing to follow a symlink: ${scoped.relative}`);
      if (err.code === 'ENOENT') fail('not-found', `no such file: ${scoped.relative}`);
      fail('permission-denied', `cannot open ${scoped.relative}: ${err.code ?? 'unknown'}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return canonical;
}

function assertContained(root: string, candidate: string, original: string): void {
  const rel = relative(root, candidate);
  // `relative()` returns something starting with '..' exactly when candidate is outside root.
  // The empty string means candidate IS root, which is fine.
  if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
    fail('path-escape', `path escapes the workspace root: ${original}`);
  }
}

/**
 * Resolves symlinks in the longest existing prefix of `p`, leaving the non-existent tail alone.
 * A plain `realpathSync` throws when the file does not exist yet — but a *write* to a new file
 * still needs its parent directories canonicalized, or a symlinked parent dir escapes the check.
 */
function canonicalizeExistingPrefix(p: string): string {
  const parts = p.split(sep);
  let existing = parts[0] === '' ? sep : parts[0]!;
  let i = parts[0] === '' ? 1 : 1;

  for (; i < parts.length; i++) {
    const next = join(existing, parts[i]!);
    try {
      statSync(next);
      existing = next;
    } catch {
      break; // everything from here on does not exist yet
    }
  }

  const realExisting = realpathSync(existing);
  const tail = parts.slice(i);
  return tail.length > 0 ? join(realExisting, ...tail) : realExisting;
}

// ---------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------

const NUL = 0x00;

/** A file with a NUL byte in its first 8 KiB is binary. Reading it as text corrupts it. */
export function isBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8192));
  return window.includes(NUL);
}

export function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface HandlerContext {
  readonly roots: HandleRoots;
  readonly grant: WorkerGrant;
  readonly signal: AbortSignal;
}

function requireWritable(ctx: HandlerContext, handle: CapabilityHandle): void {
  if (!ctx.grant.writable.includes(handle)) {
    fail('permission-denied', `the ${handle} root is not writable under the current grant`);
  }
}

function requireReadable(ctx: HandlerContext, handle: CapabilityHandle): void {
  if (!ctx.grant.readable.includes(handle)) {
    fail('permission-denied', `the ${handle} root is not readable under the current grant`);
  }
}

export async function handleRequest(ctx: HandlerContext, req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case 'list': {
      requireReadable(ctx, req.path.handle);
      const dir = resolveScoped(ctx.roots, req.path, { mustExist: true });
      const entries = readdirSync(dir, { withFileTypes: true });
      const matcher = req.glob ? globToRegExp(req.glob) : null;
      return {
        entries: entries
          .filter((e) => (matcher ? matcher.test(e.name) : true))
          .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' })),
      };
    }

    case 'grep': {
      requireReadable(ctx, req.path.handle);
      const root = resolveScoped(ctx.roots, req.path, { mustExist: true });
      const re = new RegExp(req.pattern);
      const matches: { file: string; line: number; text: string }[] = [];

      for (const file of walk(root, ctx.grant.limits.maxFileBytes)) {
        if (ctx.signal.aborted) fail('cancelled', 'grep cancelled');
        if (matches.length >= req.maxMatches) break;
        const buf = readFileSync(file);
        if (isBinary(buf)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && matches.length < req.maxMatches; i++) {
          if (re.test(lines[i]!)) {
            matches.push({
              file: relative(root, file),
              line: i + 1,
              text: lines[i]!.slice(0, 500),
            });
          }
        }
      }
      return { matches, truncated: matches.length >= req.maxMatches };
    }

    case 'read': {
      requireReadable(ctx, req.path.handle);
      const file = resolveScoped(ctx.roots, req.path, { mustExist: true });
      const stat = statSync(file);
      if (stat.size > ctx.grant.limits.maxFileBytes) {
        fail('too-large', `file is ${stat.size} bytes, limit is ${ctx.grant.limits.maxFileBytes}`);
      }
      const buf = readFileSync(file);
      if (isBinary(buf)) fail('binary-file', 'refusing to read a binary file as text');

      const text = buf.toString('utf8');
      const all = text.split('\n');
      const slice = all.slice(req.offsetLine, req.offsetLine + req.limitLines);

      return {
        content: slice.join('\n'),
        startLine: req.offsetLine + 1,
        endLine: Math.min(req.offsetLine + req.limitLines, all.length),
        totalLines: all.length,
        // Paging is explicit, so the model always knows whether it saw the whole file.
        hasMore: req.offsetLine + req.limitLines < all.length,
        digest: digest(text),
        lineEnding: detectLineEnding(text),
      };
    }

    case 'write': {
      requireWritable(ctx, req.path.handle);
      const file = resolveScoped(ctx.roots, req.path, { mustExist: false });
      if (Buffer.byteLength(req.content, 'utf8') > ctx.grant.limits.maxFileBytes) {
        fail('too-large', 'content exceeds the file size limit');
      }
      writeFileSync(file, req.content, 'utf8');
      return {
        path: req.path.relative,
        bytes: Buffer.byteLength(req.content),
        digest: digest(req.content),
      };
    }

    case 'edit': {
      requireWritable(ctx, req.path.handle);
      const file = resolveScoped(ctx.roots, req.path, { mustExist: true });
      const buf = readFileSync(file);
      if (isBinary(buf)) fail('binary-file', 'refusing to edit a binary file');

      const before = buf.toString('utf8');

      // STALE-FILE CHECK (TL-04). If the file changed since the model read it, its edit is based
      // on text that no longer exists. Applying it anyway would silently destroy whatever changed.
      if (req.expectedDigest !== null && digest(before) !== req.expectedDigest) {
        fail(
          'stale-file',
          'the file changed since it was read; re-read it and reapply the edit (the edit was NOT applied)',
        );
      }

      const occurrences = before.split(req.oldText).length - 1;
      if (occurrences === 0) fail('invalid-input', 'oldText was not found in the file');
      if (occurrences > 1) {
        fail(
          'invalid-input',
          `oldText is ambiguous: it occurs ${occurrences} times; include more context`,
        );
      }

      const eol = detectLineEnding(before);
      const after = before.replace(req.oldText, req.newText);
      // Preserve the file's existing line endings — an edit must not silently rewrite CRLF to LF.
      const normalized = eol === '\r\n' ? after.replace(/(?<!\r)\n/g, '\r\n') : after;

      writeFileSync(file, normalized, 'utf8');
      return {
        path: req.path.relative,
        digest: digest(normalized),
        diff: unifiedDiff(req.path.relative, before, normalized),
      };
    }

    case 'shell': {
      if (!ctx.grant.shell) fail('permission-denied', 'shell execution is not granted');
      const cwd = resolveScoped(ctx.roots, req.cwd, { mustExist: true });
      return await runShell(ctx, req.command, req.argv, cwd);
    }

    case 'git-status': {
      requireReadable(ctx, req.path.handle);
      const cwd = resolveScoped(ctx.roots, req.path, { mustExist: true });
      const out = runGit(ctx, cwd, ['status', '--porcelain=v1', '--branch']);
      return { porcelain: out };
    }

    case 'git-diff': {
      requireReadable(ctx, req.path.handle);
      const cwd = resolveScoped(ctx.roots, req.path, { mustExist: true });
      const args = req.staged ? ['diff', '--cached'] : ['diff'];
      return { diff: runGit(ctx, cwd, args) };
    }
  }
}

// ---------------------------------------------------------------------------

interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Runs a command with stdout and stderr kept SEPARATE, bounded output, a hard timeout, and
 * process-GROUP cleanup (`detached: true` + `kill(-pid)`).
 *
 * Killing only the leader is the classic bug: `sh -c "sleep 100 & wait"` leaves an orphan that
 * outlives the turn and keeps writing to a pipe nobody reads.
 */
function runShell(
  ctx: HandlerContext,
  command: string,
  argv: readonly string[],
  cwd: string,
): Promise<ShellResult> {
  return new Promise<ShellResult>((settle) => {
    const child = spawn(command, [...argv], {
      cwd,
      // A minimal environment. The sandbox already strips the parent env, but the worker never
      // relies on a single control: DASHSCOPE_API_KEY is not in this allowlist, so even a
      // misconfigured sandbox cannot hand the model's key to a shell command.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8' },
      // `detached` puts the child in its OWN PROCESS GROUP. That is what lets us kill the whole
      // tree below. Killing only the leader is the classic bug: `sh -c 'sleep 100 & wait'` leaves
      // an orphan that outlives the turn.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // stdout and stderr are kept SEPARATE. Interleaving them loses the distinction between a
    // tool's result and its diagnostics, and lets stderr noise corrupt parseable output.
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const limit = ctx.grant.limits.maxOutputBytes;
    const collect = (into: 'out' | 'err') => (chunk: Buffer) => {
      const current = into === 'out' ? stdout : stderr;
      if (current.length >= limit) {
        truncated = true;
        return;
      }
      const room = limit - current.length;
      const text = chunk.toString('utf8').slice(0, room);
      if (chunk.length > room) truncated = true;
      if (into === 'out') stdout += text;
      else stderr += text;

      // An output flood is stopped at the source, not merely trimmed at the end. A process
      // printing gigabytes would otherwise fill memory before we ever got to truncate it.
      if (truncated) killTree();
    };

    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    function killTree(): void {
      if (child.pid === undefined) return;
      try {
        // Negative PID signals the whole process GROUP, not just the leader.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone. Nothing to clean up.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, ctx.grant.limits.wallMs);

    const onAbort = () => killTree();
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      settle({ exitCode, stdout, stderr, truncated, timedOut });
    };

    child.on('error', (e) => {
      stderr += String(e.message);
      finish(null);
    });
    // `close` (not `exit`) — it fires after the stdio streams have been fully drained, so we
    // never report output we have not actually collected yet.
    child.on('close', (code) => finish(code));
  });
}

function runGit(ctx: HandlerContext, cwd: string, args: string[]): string {
  try {
    return execFileSync(
      'git',
      [
        // A repository's Git hooks are attacker-controlled content — a malicious repo can ship a
        // `.git/hooks/post-checkout` and wait for a tool to trigger it. Pointing `core.hooksPath`
        // at an empty directory means no repository-supplied hook can execute, whatever the repo's
        // own config says. `-c` beats repo config, which is exactly why it is used here.
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: ctx.grant.limits.wallMs,
        maxBuffer: ctx.grant.limits.maxOutputBytes,
        // Global and system config are also attacker-influenced on a shared host. Neutralize both.
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    throw new WorkerFailure({
      category: 'execution-failed',
      message: `git ${args[0] ?? ''} failed: ${err.stderr ?? err.message}`,
    });
  }
}

function* walk(root: string, maxFileBytes: number): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Never descend into .git — its contents are not source, and it holds credentials.
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          if (statSync(full).size <= maxFileBytes) yield full;
        } catch {
          // Vanished mid-walk. Skip it rather than failing the whole search.
        }
      }
      // Symlinks are deliberately NOT followed during a walk.
    }
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** A minimal, correct unified diff. Enough for review and for the TUI to render. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines = [`--- a/${path}`, `+++ b/${path}`];

  // Trim the common prefix/suffix so the hunk is tight and reviewable.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx);
  const toB = Math.min(b.length - 1, endB + ctx);

  lines.push(`@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`);
  for (let i = from; i < start; i++) lines.push(` ${a[i]!}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]!}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]!}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i]!}`);

  return lines.join('\n');
}
