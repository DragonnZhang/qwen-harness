/**
 * PS-04 — generative property over the `auto-accept-edits` profile.
 *
 * The frozen rule (docs/product/defaults.md, mirrored by the fixed matrix in `engine.test.ts`):
 * `auto-accept-edits` auto-ALLOWS exactly one thing — a dedicated workspace FILE tool
 * (`file-write` / `file-edit` / `patch`) writing an ORDINARY, non-executable file that lives
 * inside the workspace root. Everything else ASKS: shell, network, Git writes, side-effecting MCP,
 * any path outside the workspace, any protected credential path, and any file whose edit is a
 * privilege escalation (executable, package manifest, Git hook, `.git/**`).
 *
 * This test does NOT re-use the engine's own classifiers to compute the expectation. It generates
 * randomized actions bucketed into path CATEGORIES whose correct decision is written down here
 * independently, then asserts the real engine agrees for every generated action. If the profile
 * logic (or a protected-path rule, or the sensitive-edit list) regressed so that, say, a `.env`
 * write started auto-allowing, this property would fail.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { NormalizedAction } from './action.ts';
import { PolicyEngine } from './engine.ts';
import {
  WORKSPACE,
  ctx,
  digestOf,
  fileEdit,
  fileRead,
  fileWrite,
  gitRead,
  gitWrite,
  mcp,
  network,
  shell,
} from '../test/helpers.ts';

const engine = new PolicyEngine();
const profile = 'auto-accept-edits' as const;

type Expected = 'allow' | 'ask';

/**
 * A path CATEGORY. The correct `auto-accept-edits` decision depends only on the category (plus the
 * executable flag), which is exactly what makes the expectation writable independently below.
 */
type Category =
  | 'ordinary' // an ordinary workspace file — the ONLY auto-allowed write target
  | 'outside' // a path outside the workspace root
  | 'credential' // a protected credential file (.env, *.pem, .npmrc, ...)
  | 'package' // a package manifest / lockfile (edit == arbitrary install-time code)
  | 'git-hook' // a Git hook / .husky / pre-commit config
  | 'executable' // a file with an executable extension
  | 'git-internal'; // a path inside .git/**

interface Cat {
  readonly category: Category;
  readonly path: string;
}

const SAFE_DIRS = ['src', 'lib', 'pkg', 'app', 'components', 'internal'];
// Ordinary filenames that match NONE of the protected/credential/manifest/executable patterns.
const SAFE_FILES = [
  'app.ts',
  'main.rs',
  'util.py',
  'index.js',
  'notes.md',
  'data.json',
  'view.tsx',
];

const subdirs = (max: number): fc.Arbitrary<readonly string[]> =>
  fc.array(fc.constantFrom(...SAFE_DIRS), { maxLength: max });

const ordinary: fc.Arbitrary<Cat> = fc
  .tuple(subdirs(2), fc.constantFrom(...SAFE_FILES))
  .map(([dirs, file]) => ({ category: 'ordinary', path: [WORKSPACE, ...dirs, file].join('/') }));

const outside: fc.Arbitrary<Cat> = fc
  .tuple(
    fc.constantFrom('/home/dev/elsewhere', '/home/dev/other', '/tmp/work', '/var/data'),
    fc.constantFrom(...SAFE_FILES),
  )
  .map(([base, file]) => ({ category: 'outside', path: `${base}/${file}` }));

const credential: fc.Arbitrary<Cat> = fc
  .tuple(
    subdirs(1),
    fc.constantFrom(
      '.env',
      '.env.production',
      'secret.pem',
      'server.key',
      'store.p12',
      '.npmrc',
      '.netrc',
    ),
  )
  .map(([dirs, file]) => ({ category: 'credential', path: [WORKSPACE, ...dirs, file].join('/') }));

const packageManifest: fc.Arbitrary<Cat> = fc
  .tuple(
    subdirs(1),
    fc.constantFrom(
      'package.json',
      'pnpm-lock.yaml',
      'Cargo.toml',
      'Makefile',
      'pyproject.toml',
      'pom.xml',
      'Gemfile',
    ),
  )
  .map(([dirs, file]) => ({ category: 'package', path: [WORKSPACE, ...dirs, file].join('/') }));

const gitHook: fc.Arbitrary<Cat> = fc
  .constantFrom(
    `${WORKSPACE}/.husky/pre-commit`,
    `${WORKSPACE}/.husky/pre-push`,
    `${WORKSPACE}/.githooks/pre-commit`,
    `${WORKSPACE}/.pre-commit-config.yaml`,
    `${WORKSPACE}/.git/hooks/post-checkout`,
  )
  .map((path) => ({ category: 'git-hook', path }));

const executable: fc.Arbitrary<Cat> = fc
  .tuple(
    subdirs(1),
    fc.constantFrom(
      'deploy.sh',
      'run.bash',
      'build.zsh',
      'task.fish',
      'tool.ps1',
      'x.bat',
      'y.cmd',
      'z.exe',
      'app.run',
      'pkg.appimage',
    ),
  )
  .map(([dirs, file]) => ({ category: 'executable', path: [WORKSPACE, ...dirs, file].join('/') }));

const gitInternal: fc.Arbitrary<Cat> = fc
  .constantFrom(
    `${WORKSPACE}/.git/config`,
    `${WORKSPACE}/.git/HEAD`,
    `${WORKSPACE}/.git/refs/heads/main`,
    `${WORKSPACE}/.git/index`,
  )
  .map((path) => ({ category: 'git-internal', path }));

const anyCategory: fc.Arbitrary<Cat> = fc.oneof(
  ordinary,
  outside,
  credential,
  packageManifest,
  gitHook,
  executable,
  gitInternal,
);

/** The frozen expectation for a READ of a path in each category. */
function readExpected(category: Category): Expected {
  // Reads are not side effects, so the profile allows them — UNLESS the path is a protected
  // credential store, which is read-protected precisely because exfiltration is the threat.
  return category === 'credential' ? 'ask' : 'allow';
}

/** The frozen expectation for a WRITE/EDIT of a path in each category. */
function writeExpected(category: Category, executableWrite: boolean): Expected {
  if (executableWrite) return 'ask'; // producing an executable is a privilege escalation
  return category === 'ordinary' ? 'allow' : 'ask';
}

interface Case {
  readonly action: NormalizedAction;
  readonly expected: Expected;
}

const fileMutation: fc.Arbitrary<Case> = fc
  .tuple(fc.constantFrom('file-write' as const, 'file-edit' as const), anyCategory, fc.boolean())
  .map(([kind, cat, exec]) => ({
    action:
      kind === 'file-write'
        ? fileWrite(cat.path, 'content', exec)
        : fileEdit(cat.path, 'edit', exec),
    expected: writeExpected(cat.category, exec),
  }));

const patchCase: fc.Arbitrary<Case> = fc
  .tuple(fc.array(anyCategory, { minLength: 1, maxLength: 3 }), fc.boolean())
  .map(([cats, exec]) => {
    const action: NormalizedAction = {
      kind: 'patch',
      paths: cats.map((c) => c.path),
      createsExecutable: exec,
      patchDigest: digestOf('patch-body'),
    };
    // A patch auto-allows only when it is non-executable AND every path is an ordinary workspace
    // file. One outside/protected/sensitive path (or the executable bit) forces an ask.
    const allOrdinary = cats.every((c) => c.category === 'ordinary');
    return { action, expected: !exec && allOrdinary ? 'allow' : 'ask' };
  });

const fileReadCase: fc.Arbitrary<Case> = anyCategory.map((cat) => ({
  action: fileRead(cat.path),
  expected: readExpected(cat.category),
}));

const shellCase: fc.Arbitrary<Case> = fc
  .constantFrom('ls -la', 'mkdir build', 'rm -rf x', 'echo hi', 'cat f', 'git log', 'mv a b')
  .map((command) => ({ action: shell(command), expected: 'ask' as const }));

const gitReadCase: fc.Arbitrary<Case> = fc.constant({
  action: gitRead(),
  expected: 'allow' as const,
});

const gitWriteCase: fc.Arbitrary<Case> = fc.boolean().map((destructive) => ({
  action: gitWrite(destructive ? 'reset --hard' : 'commit', destructive),
  expected: 'ask' as const,
}));

const networkCase: fc.Arbitrary<Case> = fc
  .constantFrom('https://example.com/x', 'https://api.test/v1', 'http://internal/data')
  .map((url) => ({ action: network(url, 'example.com'), expected: 'ask' as const }));

const mcpCase: fc.Arbitrary<Case> = fc.boolean().map((sideEffect) => ({
  action: mcp(sideEffect, sideEffect ? 'create_issue' : 'search_issues'),
  expected: sideEffect ? ('ask' as const) : ('allow' as const),
}));

const anyCase: fc.Arbitrary<Case> = fc.oneof(
  fileMutation,
  patchCase,
  fileReadCase,
  shellCase,
  gitReadCase,
  gitWriteCase,
  networkCase,
  mcpCase,
);

describe('PS-04: auto-accept-edits decision matches the frozen rule for every generated action', () => {
  it('property: every randomized action decides exactly as the frozen category rule says', () => {
    fc.assert(
      fc.property(anyCase, ({ action, expected }) => {
        const decision = engine.evaluate(action, ctx({ profile }));
        // The whole point: an auto-accept-edits verdict is either allow or ask, never deny/passthrough
        // for a canonical model action with no rules/grants/managed ceiling.
        expect(decision.outcome, JSON.stringify(decision.trace, null, 2)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('property: the profile NEVER auto-allows a shell, network, git-write, or side-effecting MCP', () => {
    const alwaysAsk: fc.Arbitrary<NormalizedAction> = fc.oneof(
      shellCase.map((c) => c.action),
      networkCase.map((c) => c.action),
      gitWriteCase.map((c) => c.action),
      fc.constant(mcp(true, 'create_issue')),
    );
    fc.assert(
      fc.property(alwaysAsk, (action) => {
        expect(engine.evaluate(action, ctx({ profile })).outcome).toBe('ask');
      }),
      { numRuns: 200 },
    );
  });

  it('property: an ordinary non-executable workspace write is auto-allowed by the profile stage', () => {
    fc.assert(
      fc.property(
        ordinary,
        fc.constantFrom('file-write' as const, 'file-edit' as const),
        (cat, kind) => {
          const action =
            kind === 'file-write'
              ? fileWrite(cat.path, 'x', false)
              : fileEdit(cat.path, 'e', false);
          const decision = engine.evaluate(action, ctx({ profile }));
          expect(decision.outcome).toBe('allow');
          expect(decision.source).toEqual({ stage: 'profile', id: 'profile:auto-accept-edits' });
        },
      ),
      { numRuns: 200 },
    );
  });
});
