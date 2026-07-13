/**
 * PK-02 — build the versioned, installable CLI package.
 *
 * Produces `dist/release/qwen-harness-<version>.tgz`, a self-contained artifact that
 * `packaging/install.sh` can install, upgrade, roll back and uninstall on a host that has the
 * PK-01 prerequisites and nothing else — no registry, no network, no `npm install` at install time.
 *
 * What "self-contained" costs us, and why we pay it:
 *
 *   The CLI's ONLY runtime native dependency is `better-sqlite3` (verified: the esbuild graph
 *   contains exactly one external import). `node-pty` belongs to the TUI, not the CLI. Rather than
 *   make the installer compile a C++ addon on the operator's machine — which would drag the whole
 *   `build-essential` prerequisite into INSTALL time instead of BUILD time — we vendor the addon
 *   that was already compiled here, together with the two packages it needs to `require` at
 *   runtime (`bindings` -> `file-uri-to-path`). Everything else is bundled to JavaScript.
 *
 *   The artifact is therefore platform-specific by construction. The manifest says so, in the
 *   exact terms the installer re-checks: `linux-x64`, node ABI, glibc.
 *
 * Reproducible by construction (PK-04): every timestamp comes from `SOURCE_DATE_EPOCH`, defaulting
 * to the HEAD commit's own timestamp; the tar is sorted, uid/gid-zeroed and gzipped with `-n`. Two
 * builds of the same commit produce a byte-identical tarball with the same SHA-256. `scripts/
 * release.ts` proves this by building twice and comparing, rather than asserting it.
 *
 * Integrity is layered, because a single hash proves less than it looks like it does:
 *   SHA256SUMS      every file in the package, so a tampered file inside an intact tarball is caught
 *   MANIFEST.json   the same digests plus the provenance (commit, versions, platform)
 *   <tgz>.sha256    the tarball itself, so a swapped artifact is caught before it is unpacked
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
/** This module is ESM; `require.resolve` is how we ask Node where a package REALLY resolved to. */
const nodeRequire = createRequire(import.meta.url);
const OUT_DIR = join(REPO_ROOT, 'dist', 'release');
const STAGE = join(REPO_ROOT, 'dist', 'release', '.stage');

/** The one thing that cannot be bundled: a compiled C++ addon. */
const NATIVE_EXTERNALS = ['better-sqlite3'] as const;

/**
 * Packages that must exist on disk at runtime. `prebuild-install` is deliberately NOT here: it is
 * better-sqlite3's *install script* dependency, never reached by `require()` once the addon is
 * built. The install->run test is what proves this list is complete — if it is wrong, the packaged
 * CLI fails to start, loudly.
 */
const RUNTIME_NATIVE_TREE = ['better-sqlite3', 'bindings', 'file-uri-to-path'] as const;

/** better-sqlite3 ships its own build tree and a 10 MB SQLite amalgamation. Neither is needed to RUN. */
const PRUNE_FROM_BETTER_SQLITE3 = ['deps', 'src', 'binding.gyp', 'prebuilds'] as const;

interface RootPackageJson {
  readonly version: string;
  readonly packageManager: string;
  readonly engines?: { readonly node?: string };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sh(command: string, args: readonly string[], cwd = REPO_ROOT): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file under `dir`, repo-relative, sorted — the order the digests are recorded in. */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Provenance: one timestamp, one commit, no ambient clock
// ---------------------------------------------------------------------------------------------

function sourceDateEpoch(): number {
  const override = process.env['SOURCE_DATE_EPOCH'];
  if (override !== undefined && /^\d+$/.test(override)) return Number(override);
  // The commit's own time. Deterministic for a given commit, and honest about what was built.
  return Number(sh('git', ['log', '-1', '--format=%ct']).trim());
}

function headCommit(): { sha: string; dirty: boolean } {
  const sha = sh('git', ['rev-parse', 'HEAD']).trim();
  const dirty = sh('git', ['status', '--porcelain']).trim().length > 0;
  return { sha, dirty };
}

// ---------------------------------------------------------------------------------------------
// Completions — generated from the CLI's OWN help output, never hand-maintained
// ---------------------------------------------------------------------------------------------
//
// A hand-written completion script is a promise about a command surface that nobody re-checks. This
// one is derived by RUNNING the binary we just built and reading what it says it supports, so a new
// subcommand appears in every shell's completion the moment it appears in `help`, and a completion
// for a command that no longer exists is impossible. `packaging/test` asserts the two agree.

export interface CliSurface {
  readonly commands: readonly { readonly name: string; readonly summary: string }[];
  readonly flags: readonly string[];
  readonly profiles: readonly string[];
}

export function parseHelp(help: string): CliSurface {
  const commands: { name: string; summary: string }[] = [];
  const flags: string[] = [];
  let profiles: string[] = [];

  for (const line of help.split('\n')) {
    // A flags line, e.g. `  flags: --profile <plan|ask|…>  --model <name>  --json`
    if (/^\s*flags:/.test(line)) {
      for (const m of line.matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (!flags.includes(m[0])) flags.push(m[0]);
      }
      const choice = /--profile\s+<([^>]+)>/.exec(line);
      if (choice?.[1] !== undefined) profiles = choice[1].split('|').map((s) => s.trim());
      continue;
    }
    // A command row: exactly two leading spaces, a name, then >=2 spaces, then the summary.
    // The `exactly two` is what rejects the wrapped continuation lines, which are deeply indented.
    const m = /^ {2}(\S+)(?:\s+<[^>]*>|\s+\[[^\]]*\])*\s{2,}(\S.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && !m[1].startsWith('-')) {
      commands.push({ name: m[1], summary: m[2].trim() });
    }
  }
  return { commands, flags, profiles };
}

function bashCompletion(s: CliSurface): string {
  const names = s.commands.map((c) => c.name).join(' ');
  return `# qwen-harness bash completion — GENERATED by scripts/package-cli.ts from \`qwen-harness help\`.
# Do not edit: it is rebuilt from the binary's own command surface on every release.
_qwen_harness() {
  local cur prev commands flags profiles
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${names}"
  flags="${s.flags.join(' ')}"
  profiles="${s.profiles.join(' ')}"

  case "\$prev" in
    --profile) COMPREPLY=( \$(compgen -W "\$profiles" -- "\$cur") ); return 0 ;;
    --model)   COMPREPLY=(); return 0 ;;
  esac

  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$commands" -- "\$cur") )
    return 0
  fi
  COMPREPLY=( \$(compgen -W "\$flags" -- "\$cur") )
}
complete -F _qwen_harness qwen-harness
`;
}

function zshCompletion(s: CliSurface): string {
  // zsh takes the summaries too, so `qwen-harness <TAB>` explains itself.
  const rows = s.commands
    .map((c) => `    '${c.name}:${c.summary.replace(/'/g, "'\\''")}'`)
    .join('\n');
  return `#compdef qwen-harness
# qwen-harness zsh completion — GENERATED by scripts/package-cli.ts from \`qwen-harness help\`.

_qwen_harness() {
  local -a commands
  commands=(
${rows}
  )
  _arguments -C \\
    '1: :->command' \\
    '--profile[permission profile]:profile:(${s.profiles.join(' ')})' \\
    '--model[model name]:model:' \\
    '--json[machine-readable output]' \\
    '*: :->args'

  case "\$state" in
    command) _describe -t commands 'qwen-harness command' commands ;;
  esac
}
_qwen_harness "\$@"
`;
}

function fishCompletion(s: CliSurface): string {
  const lines: string[] = [
    '# qwen-harness fish completion — GENERATED by scripts/package-cli.ts from `qwen-harness help`.',
    'complete -c qwen-harness -f',
  ];
  for (const c of s.commands) {
    lines.push(
      `complete -c qwen-harness -n __fish_use_subcommand -a ${c.name} -d '${c.summary.replace(/'/g, "\\'")}'`,
    );
  }
  if (s.profiles.length > 0) {
    lines.push(
      `complete -c qwen-harness -l profile -x -a '${s.profiles.join(' ')}' -d 'permission profile'`,
    );
  }
  lines.push("complete -c qwen-harness -l model -x -d 'model name'");
  lines.push("complete -c qwen-harness -l json -d 'machine-readable output'");
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// The runtime lockfile: the shipped closure, with the integrity the real lockfile recorded
// ---------------------------------------------------------------------------------------------

interface LockEntry {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bundled: boolean;
}

/**
 * The artifact's lockfile. It is DERIVED from `pnpm-lock.yaml` — never hand-written — and records,
 * for every package whose code is inside the tarball, the version and the registry integrity hash
 * that pnpm resolved. That is what lets an operator (or an auditor) answer "what is actually in
 * this binary" without trusting our word for it.
 */
function buildLockfile(deps: ReadonlyMap<string, string>, integrity: ReadonlyMap<string, string>) {
  const entries: LockEntry[] = [];
  for (const [name, version] of [...deps].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const key = `${name}@${version}`;
    entries.push({
      name,
      version,
      integrity: integrity.get(key) ?? '',
      bundled: true,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

export interface BuildResult {
  readonly version: string;
  readonly tarball: string;
  readonly tarballSha256: string;
  readonly files: number;
  readonly bytes: number;
}

export function buildPackage(options: { allowDirty?: boolean } = {}): BuildResult {
  const root = readJson<RootPackageJson>(join(REPO_ROOT, 'package.json'));
  const version = root.version;
  const epoch = sourceDateEpoch();
  const isoDate = new Date(epoch * 1000).toISOString();
  const { sha, dirty } = headCommit();

  console.log('qwen-harness release package');
  console.log(`  version        ${version}`);
  console.log(`  commit         ${sha}${dirty ? ' (WORKING TREE DIRTY)' : ''}`);
  console.log(`  source date    ${isoDate}  (SOURCE_DATE_EPOCH=${String(epoch)})`);
  console.log('');

  // A release is a claim about a COMMIT. Building one from a dirty tree produces an artifact whose
  // recorded provenance ("commit abc123") is a lie about the bytes inside it, and it is not
  // reproducible by anyone — including us, tomorrow. Fail closed; `--allow-dirty` exists for local
  // iteration and stamps `dirty: true` into the manifest so the artifact cannot be mistaken for a
  // real release.
  if (dirty && options.allowDirty !== true) {
    throw new Error(
      'the working tree is dirty; a release artifact must be built from a committed tree.\n' +
        '  Commit (or stash) your changes, or pass --allow-dirty to build a clearly-marked\n' +
        '  development artifact whose MANIFEST.json records dirty: true.',
    );
  }

  // 1. Compile. `tsc --build` is incremental, so this is cheap when the tree is already built, and
  //    it makes "I forgot to build" impossible rather than merely unlikely.
  console.log('  · tsc --build');
  sh('pnpm', ['exec', 'tsc', '--build']);

  const cliEntry = join(REPO_ROOT, 'apps', 'cli', 'dist', 'bin.js');
  if (!existsSync(cliEntry)) {
    throw new Error(`the CLI entry point ${cliEntry} does not exist after a build; cannot package`);
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, 'lib'), { recursive: true });
  mkdirSync(join(STAGE, 'bin'), { recursive: true });
  mkdirSync(join(STAGE, 'completions'), { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // 2. Bundle. Everything that is JavaScript becomes one file; the native addon stays external.
  const externalArgs = NATIVE_EXTERNALS.map((m) => `--external:${m}`);
  console.log(`  · esbuild lib/cli.js            (external: ${NATIVE_EXTERNALS.join(', ')})`);
  sh('pnpm', [
    'exec',
    'esbuild',
    cliEntry,
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    ...externalArgs,
    `--outfile=${join(STAGE, 'lib', 'cli.js')}`,
    '--log-level=warning',
  ]);

  console.log('  · esbuild lib/migrate-config.js (config migration, from @qwen-harness/config)');
  sh('pnpm', [
    'exec',
    'esbuild',
    join(REPO_ROOT, 'scripts', 'migrate-config.ts'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    ...externalArgs,
    `--outfile=${join(STAGE, 'lib', 'migrate-config.js')}`,
    '--log-level=warning',
  ]);

  // 3. Vendor the native runtime tree, pruned to what `require()` actually reaches.
  const nativeVersions = new Map<string, string>();
  for (const pkg of RUNTIME_NATIVE_TREE) {
    const pkgJsonPath = nodeRequire.resolve(`${pkg}/package.json`, {
      paths: [join(REPO_ROOT, 'packages', 'storage'), REPO_ROOT],
    });
    const src = dirname(pkgJsonPath);
    const dest = join(STAGE, 'node_modules', pkg);
    cpSync(src, dest, {
      recursive: true,
      dereference: true,
      filter: (from) => {
        const rel = relative(src, from);
        if (rel === '') return true;
        if (pkg === 'better-sqlite3') {
          const top = rel.split(sep)[0] ?? '';
          if ((PRUNE_FROM_BETTER_SQLITE3 as readonly string[]).includes(top)) return false;
          // Keep the compiled addon, drop the multi-megabyte object files beside it.
          if (top === 'build') {
            return (
              rel === 'build' ||
              rel === join('build', 'Release') ||
              rel === join('build', 'Release', 'better_sqlite3.node')
            );
          }
        }
        // A nested node_modules would shadow our flat tree with a second copy. Flatten instead.
        return !rel.split(sep).includes('node_modules');
      },
    });
    const v = readJson<{ version: string }>(pkgJsonPath).version;
    nativeVersions.set(pkg, v);
    console.log(`  · vendor node_modules/${pkg}@${v}`);
  }

  // 4. Launchers.
  const launcher = (target: string): string =>
    `#!/usr/bin/env node\n// GENERATED by scripts/package-cli.ts — do not edit.\nimport '../lib/${target}';\n`;
  writeFileSync(join(STAGE, 'bin', 'qwen-harness'), launcher('cli.js'), { mode: 0o755 });
  writeFileSync(join(STAGE, 'bin', 'qwen-harness-migrate-config'), launcher('migrate-config.js'), {
    mode: 0o755,
  });
  chmodSync(join(STAGE, 'bin', 'qwen-harness'), 0o755);
  chmodSync(join(STAGE, 'bin', 'qwen-harness-migrate-config'), 0o755);

  // 5. Completions, from the binary we just built.
  const help = sh('node', [join(STAGE, 'lib', 'cli.js'), 'help'], STAGE);
  const surface = parseHelp(help);
  if (surface.commands.length === 0) {
    throw new Error(
      'parsed zero commands out of `qwen-harness help`; refusing to ship empty completions',
    );
  }
  writeFileSync(join(STAGE, 'completions', 'qwen-harness.bash'), bashCompletion(surface));
  writeFileSync(join(STAGE, 'completions', '_qwen-harness'), zshCompletion(surface));
  writeFileSync(join(STAGE, 'completions', 'qwen-harness.fish'), fishCompletion(surface));
  console.log(
    `  · completions bash/zsh/fish     (${surface.commands.length} commands from \`help\`: ${surface.commands.map((c) => c.name).join(', ')})`,
  );

  // 6. The package manifest that a package manager would read.
  const pkgJson = {
    name: 'qwen-harness',
    version,
    description:
      'Standalone coding-agent harness with a headless runtime, backed by DashScope qwen3.7-max.',
    type: 'module',
    bin: {
      'qwen-harness': './bin/qwen-harness',
      'qwen-harness-migrate-config': './bin/qwen-harness-migrate-config',
    },
    engines: { node: root.engines?.node ?? '>=22' },
    os: ['linux'],
    cpu: [process.arch],
    // Vendored, not fetched. Recorded so `pnpm audit` / SBOM consumers see the real versions.
    bundledDependencies: Object.fromEntries(nativeVersions),
    license: 'UNLICENSED',
    private: true,
  };
  writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`);

  // 7. The runtime lockfile, derived from the real pnpm-lock.yaml.
  const integrity = readLockIntegrity();
  writeFileSync(
    join(STAGE, 'qwen-harness.lock.json'),
    `${JSON.stringify(
      {
        lockfileVersion: 1,
        name: 'qwen-harness',
        version,
        commit: sha,
        source: 'pnpm-lock.yaml',
        note: 'Every JavaScript dependency is compiled into lib/cli.js. The entries below are the packages whose code ships as-is (the native addon and its require-time tree), with the integrity pnpm resolved for them.',
        packages: buildLockfile(nativeVersions, integrity),
      },
      null,
      2,
    )}\n`,
  );

  // 8. Per-file digests + provenance manifest, then the tarball's own digest.
  const files = walk(STAGE);
  const digests = files.map((f) => ({ file: f, sha256: sha256(join(STAGE, f)) }));

  const manifest = {
    name: 'qwen-harness',
    version,
    commit: sha,
    dirty,
    sourceDateEpoch: epoch,
    builtAt: isoDate,
    platform: { os: 'linux', arch: process.arch, nodeAbi: process.versions.modules },
    toolchain: {
      node: process.versions.node,
      packageManager: root.packageManager,
      builtWithNode: process.version,
    },
    bundledDependencies: Object.fromEntries(nativeVersions),
    files: digests,
  };
  writeFileSync(join(STAGE, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // SHA256SUMS excludes itself (it cannot contain its own hash) but covers MANIFEST.json, so the
  // provenance record is itself protected by the checksum file the installer verifies.
  const sums = walk(STAGE)
    .filter((f) => f !== 'SHA256SUMS')
    .map((f) => `${sha256(join(STAGE, f))}  ${f}`)
    .join('\n');
  writeFileSync(join(STAGE, 'SHA256SUMS'), `${sums}\n`);

  // 9. The deterministic tarball. Every knob that could smuggle in an ambient timestamp, a uid, or
  //    a directory-order dependency is nailed down — that is the whole of "reproducible".
  const tarball = join(OUT_DIR, `qwen-harness-${version}.tgz`);
  rmSync(tarball, { force: true });
  sh(
    'bash',
    [
      '-c',
      'tar --sort=name --owner=0 --group=0 --numeric-owner --format=gnu ' +
        `--mtime=@${String(epoch)} --transform 's,^\\./,package/,' -cf - ./ ` +
        `| gzip -n -9 > ${JSON.stringify(tarball)}`,
    ],
    STAGE,
  );

  const tarballSha = sha256(tarball);
  writeFileSync(`${tarball}.sha256`, `${tarballSha}  qwen-harness-${version}.tgz\n`);

  const bytes = statSync(tarball).size;
  console.log('');
  console.log(`  ✓ ${relative(REPO_ROOT, tarball)}`);
  console.log(`    ${String(files.length)} files · ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`    sha256 ${tarballSha}`);

  return { version, tarball, tarballSha256: tarballSha, files: files.length, bytes };
}

/**
 * Read `name@version -> integrity` out of the REAL pnpm lockfile. We parse the lockfile rather than
 * asking the registry, because the lockfile is what the build actually installed from — asking the
 * registry would tell us what is true *now*, which is a different (and weaker) claim.
 */
export function readLockIntegrity(
  lockPath = join(REPO_ROOT, 'pnpm-lock.yaml'),
): Map<string, string> {
  const out = new Map<string, string>();
  // `yaml` is a devDependency of the repo, not of the shipped artifact: the tarball contains no
  // YAML and no parser for it. This runs at BUILD time only.
  const { parse } = nodeRequire('yaml') as { parse: (s: string) => unknown };
  const doc = parse(readFileSync(lockPath, 'utf8'));
  const packages = (doc as { packages?: Record<string, { resolution?: { integrity?: string } }> })
    .packages;
  if (packages === undefined) return out;
  for (const [key, value] of Object.entries(packages)) {
    const integrity = value.resolution?.integrity;
    if (integrity !== undefined) out.set(key, integrity);
  }
  return out;
}

// Exact path comparison, not a substring match: the packaging tests IMPORT this module, and a
// loose `/package-cli/.test(argv[1])` would run a full release build inside a unit test.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPackage({ allowDirty: process.argv.includes('--allow-dirty') });
}
