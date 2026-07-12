import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A disposable Git repository on real disk.
 *
 * Integration and E2E evidence must use REAL local dependencies and processes (evidence class I),
 * so tools that touch the filesystem and Git are exercised against an actual repo, not a mock fs.
 * Every fixture is created under a fresh temp dir and removed on dispose, so a failing test can
 * never leave state behind that a later test depends on.
 */
export class FixtureRepo {
  readonly root: string;
  #disposed = false;

  private constructor(root: string) {
    this.root = root;
  }

  static create(files: Record<string, string> = {}, opts: { git?: boolean } = {}): FixtureRepo {
    const root = mkdtempSync(join(tmpdir(), 'qh-fixture-'));
    const repo = new FixtureRepo(root);

    for (const [rel, content] of Object.entries(files)) repo.write(rel, content);

    if (opts.git !== false) {
      repo.git('init', '--quiet', '--initial-branch=main');
      repo.git('config', 'user.email', 'fixture@example.invalid');
      repo.git('config', 'user.name', 'Fixture');
      // Commit hooks are a documented attack surface (security gate). A fixture must never
      // silently execute one, so they are disabled unless a test explicitly re-enables them.
      repo.git('config', 'core.hooksPath', '/dev/null');
      if (Object.keys(files).length > 0) {
        repo.git('add', '-A');
        repo.git('commit', '--quiet', '-m', 'fixture');
      }
    }

    return repo;
  }

  write(rel: string, content: string): string {
    const abs = join(this.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return abs;
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  isDirty(): boolean {
    return this.git('status', '--porcelain').trim().length > 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    rmSync(this.root, { recursive: true, force: true });
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
