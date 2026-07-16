/**
 * The architecture gate. Run with `pnpm architecture`.
 *
 * `scripts/graph.ts` declares the intended shape of the system. This script reads the REAL
 * TypeScript source of every workspace package and app and proves the declaration true. If the
 * code and the graph ever disagree, the build stops here.
 *
 * Enforced boundaries:
 *
 *   1. Dependency direction   a package may only import packages listed in its PACKAGE_DEPS entry
 *   2. Apps are terminal      no package may import an app
 *   3. Acyclic                neither the real import graph nor PACKAGE_DEPS may contain a cycle
 *   4. Legal I/O owners       a package may only open a host capability listed for it in IO_OWNERS
 *   5. Pure packages          PURE_PACKAGES touch no host capability, no clock, no RNG, no env
 *   6. Credential isolation   only provider-dashscope and secret-store may name DASHSCOPE_API_KEY
 *   7. Package shape          every package has a README.md and a src/index.ts (warning-level)
 *
 * This script lives in `scripts/`, which is not a workspace package, so it is exempt from its own
 * rules. It uses only `node:fs`, `node:path` and `node:url`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IO_OWNERS, LAYERS, PACKAGE_DEPS, PURE_PACKAGES } from './graph.ts';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SCOPE = '@qwen-harness/';

/**
 * Modules that hand a caller a real host capability: a filesystem, a process, a socket, shared
 * memory. Importing one of these is the act the gate cares about.
 */
const HOST_CAPABILITY_MODULES = new Set([
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'node:os',
  'node:dgram',
  'node:worker_threads',
  'node:v8',
  'better-sqlite3',
  'undici',
]);

/**
 * Node builtins that compute rather than reach out. Always legal, in every package, including the
 * pure ones. They are listed explicitly so that a new builtin is a deliberate decision.
 */
const ALWAYS_ALLOWED_MODULES = new Set([
  'node:path',
  'node:crypto',
  'node:util',
  'node:events',
  'node:stream',
  'node:stream/promises',
  'node:stream/web',
  'node:assert',
  'node:assert/strict',
  'node:url',
  'node:buffer',
  'node:timers',
  'node:timers/promises',
]);

/** Determinism hazards. A pure package may not name any of them. */
const IMPURE_TOKENS = ['Date.now(', 'Math.random(', 'process.env'];

const CREDENTIAL_NAME = 'DASHSCOPE_API_KEY';
const CREDENTIAL_OWNERS = new Set(['provider-dashscope', 'secret-store']);

const APPS: readonly string[] = LAYERS.apps;

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

interface Unit {
  /** Bare name, e.g. `storage` or `cli`. */
  readonly name: string;
  /** `packages` or `apps`. */
  readonly kind: 'packages' | 'apps';
  /** Absolute path to the unit root. */
  readonly dir: string;
  /** Absolute paths of non-test `src/**\/*.ts` files. Empty if `src/` does not exist yet. */
  readonly files: readonly string[];
}

interface ImportRef {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

interface RuleResult {
  readonly id: string;
  readonly title: string;
  readonly failures: Finding[];
  readonly warnings: Finding[];
}

// ---------------------------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------------------------

function listTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...listTypeScriptFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out.sort();
}

function loadUnits(): Unit[] {
  const units: Unit[] = [];
  for (const kind of ['packages', 'apps'] as const) {
    const root = join(REPO_ROOT, kind);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      units.push({
        name,
        kind,
        dir,
        files: listTypeScriptFiles(join(dir, 'src')),
      });
    }
  }
  return units;
}

/**
 * Blank out comments and template/quoted string bodies while preserving every newline, so that a
 * match index still maps to the right line. Prevents a doc comment that mentions `Date.now()` (or
 * a rule name in prose) from tripping a gate, while keeping import specifiers intact — those are
 * recovered from the ORIGINAL text, not from this one.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Recover every module specifier a file pulls in: static `import`/`export ... from`, bare
 * side-effect `import 'x'`, dynamic `import('x')`, and `require('x')`.
 */
function parseImports(file: string, source: string): ImportRef[] {
  const code = stripComments(source);
  const refs: ImportRef[] = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^'"();]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      // The patterns may consume a leading separator (including a newline); report the line of the
      // `import`/`export`/`require` keyword itself, not of the character before it.
      const lead = match[0].search(/\S/);
      const line = lineOf(code, match.index + (lead === -1 ? 0 : lead));
      const key = `${line}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ file, line, specifier });
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}

/** `undici/types` -> `undici`; `fs/promises` -> `node:fs/promises`; `./x.ts` -> null. */
function normalizeSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return specifier;
  const bare = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
  // A legacy unprefixed builtin is the same capability under a different name.
  const asNode = `node:${specifier}`;
  if (HOST_CAPABILITY_MODULES.has(asNode) || ALWAYS_ALLOWED_MODULES.has(asNode)) return asNode;
  const asNodeBare = `node:${bare}`;
  if (HOST_CAPABILITY_MODULES.has(asNodeBare)) return asNodeBare;
  return bare;
}

/** `@qwen-harness/storage` -> `storage`; anything else -> null. */
function workspaceTarget(specifier: string): string | null {
  if (!specifier.startsWith(SCOPE)) return null;
  const rest = specifier.slice(SCOPE.length);
  return rest.split('/')[0] ?? null;
}

function rel(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

// ---------------------------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------------------------

/** Depth-first search for the first cycle, returned as a node path `a -> b -> a`. */
function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (state.get(next) === 'open') {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state.get(next) === undefined && graph.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };

  for (const node of [...graph.keys()].sort()) {
    if (state.get(node) === undefined) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

const units = loadUnits();
const sources = new Map<string, string>();
const importsOf = new Map<string, ImportRef[]>();

for (const unit of units) {
  const refs: ImportRef[] = [];
  for (const file of unit.files) {
    const source = readFileSync(file, 'utf8');
    sources.set(file, source);
    refs.push(...parseImports(file, source));
  }
  importsOf.set(`${unit.kind}/${unit.name}`, refs);
}

const unitOf = (unit: Unit): string => `${unit.kind}/${unit.name}`;
const results: RuleResult[] = [];

// --- Rule 1: dependency direction ------------------------------------------------------------
{
  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  for (const unit of units) {
    const declared = PACKAGE_DEPS[unit.name as keyof typeof PACKAGE_DEPS] as
      readonly string[] | undefined;
    if (declared === undefined) {
      warnings.push({
        file: rel(unit.dir),
        line: 0,
        message: `${unit.kind}/${unit.name} has no PACKAGE_DEPS entry in scripts/graph.ts; its imports cannot be checked`,
      });
      continue;
    }
    for (const ref of importsOf.get(unitOf(unit)) ?? []) {
      const target = workspaceTarget(ref.specifier);
      if (target === null || target === unit.name) continue;
      if (!declared.includes(target)) {
        failures.push({
          file: rel(ref.file),
          line: ref.line,
          message: `${unit.name} imports ${target} but ${target} is not a declared dependency of ${unit.name} (add it to PACKAGE_DEPS.${unit.name} in scripts/graph.ts, or remove the import)`,
        });
      }
    }
  }
  results.push({
    id: '1',
    title: 'Dependency direction matches PACKAGE_DEPS',
    failures,
    warnings,
  });
}

// --- Rule 2: no package imports an app --------------------------------------------------------
{
  const failures: Finding[] = [];
  for (const unit of units) {
    if (unit.kind !== 'packages') continue;
    for (const ref of importsOf.get(unitOf(unit)) ?? []) {
      const target = workspaceTarget(ref.specifier);
      if (target !== null && APPS.includes(target)) {
        failures.push({
          file: rel(ref.file),
          line: ref.line,
          message: `package ${unit.name} imports app ${target}; apps are the composition root and nothing under packages/ may depend on one`,
        });
      }
    }
  }
  results.push({
    id: '2',
    title: 'No package imports an app',
    failures,
    warnings: [],
  });
}

// --- Rule 3: no cycles ------------------------------------------------------------------------
{
  const failures: Finding[] = [];

  const actual = new Map<string, Set<string>>();
  for (const unit of units) actual.set(unit.name, new Set());
  for (const unit of units) {
    for (const ref of importsOf.get(unitOf(unit)) ?? []) {
      const target = workspaceTarget(ref.specifier);
      if (target === null || target === unit.name) continue;
      actual.get(unit.name)?.add(target);
    }
  }
  const actualCycle = findCycle(actual);
  if (actualCycle) {
    failures.push({
      file: 'packages/**/src',
      line: 0,
      message: `cycle in the real import graph: ${actualCycle.join(' -> ')}`,
    });
  }

  const declaredGraph = new Map<string, Set<string>>();
  for (const [name, deps] of Object.entries(PACKAGE_DEPS)) {
    declaredGraph.set(name, new Set(deps));
  }
  const declaredCycle = findCycle(declaredGraph);
  if (declaredCycle) {
    failures.push({
      file: 'scripts/graph.ts',
      line: 0,
      message: `cycle in the declared PACKAGE_DEPS graph: ${declaredCycle.join(' -> ')}`,
    });
  }

  results.push({
    id: '3',
    title: 'No cycles (real import graph and declared PACKAGE_DEPS)',
    failures,
    warnings: [],
  });
}

// --- Rule 4: legal I/O owners -----------------------------------------------------------------
{
  const failures: Finding[] = [];
  for (const unit of units) {
    // Apps are the composition root: they are allowed to open host capabilities freely.
    if (unit.kind !== 'packages') continue;
    const allowed = new Set(IO_OWNERS[unit.name]?.modules ?? []);
    for (const ref of importsOf.get(unitOf(unit)) ?? []) {
      const module = normalizeSpecifier(ref.specifier);
      if (module === null || !HOST_CAPABILITY_MODULES.has(module)) continue;
      if (allowed.has(module)) continue;
      const owners = Object.entries(IO_OWNERS)
        .filter(([, entry]) => entry.modules.includes(module))
        .map(([owner]) => owner);
      const hint =
        owners.length > 0
          ? `only ${owners.join(', ')} may open it — route through one of them`
          : 'no package is a declared owner of this capability';
      failures.push({
        file: rel(ref.file),
        line: ref.line,
        message: `${unit.name} imports host capability '${module}' but it is not listed in IO_OWNERS.${unit.name}; ${hint}`,
      });
    }
  }
  results.push({
    id: '4',
    title: 'Host I/O only in declared IO_OWNERS',
    failures,
    warnings: [],
  });
}

// --- Rule 5: pure packages --------------------------------------------------------------------
{
  const failures: Finding[] = [];
  for (const unit of units) {
    if (unit.kind !== 'packages' || !PURE_PACKAGES.includes(unit.name)) continue;

    for (const ref of importsOf.get(unitOf(unit)) ?? []) {
      const module = normalizeSpecifier(ref.specifier);
      if (module === null || !HOST_CAPABILITY_MODULES.has(module)) continue;
      failures.push({
        file: rel(ref.file),
        line: ref.line,
        message: `${unit.name} is a PURE package and imports host capability '${module}'; pure packages open no host capability at all`,
      });
    }

    for (const file of unit.files) {
      const code = stripComments(sources.get(file) ?? '');
      for (const token of IMPURE_TOKENS) {
        let from = code.indexOf(token);
        while (from !== -1) {
          failures.push({
            file: rel(file),
            line: lineOf(code, from),
            message: `${unit.name} is a PURE package and references '${token}'; inject a Clock / RNG / config value instead`,
          });
          from = code.indexOf(token, from + token.length);
        }
      }
    }
  }
  results.push({
    id: '5',
    title: `Pure packages are pure (${PURE_PACKAGES.join(', ')})`,
    failures,
    warnings: [],
  });
}

// --- Rule 6: DASHSCOPE_API_KEY isolation ------------------------------------------------------
//
// The threat-model invariant is precise: only the provider boundary may READ the credential VALUE,
// and "lint/architecture tests reject other `process.env` access to it". So the rule forbids
// reading it from the environment — `process.env.DASHSCOPE_API_KEY` and its bracket/destructure
// forms — anywhere but the owners. It deliberately does NOT forbid merely NAMING the string: config
// legitimately documents that `apiKeyEnv` holds the NAME `DASHSCOPE_API_KEY` (never the value), and
// a doc comment or error message may use it as an example. Naming the env var is not reading it.
{
  const failures: Finding[] = [];
  // Any read of the key out of the environment, in the forms a program actually uses.
  const ENV_READ_PATTERNS: RegExp[] = [
    /process\.env\s*\.\s*DASHSCOPE_API_KEY\b/,
    /process\.env\s*\[\s*['"`]DASHSCOPE_API_KEY['"`]\s*\]/,
    // destructuring: const { DASHSCOPE_API_KEY } = process.env
    /\{[^}]*\bDASHSCOPE_API_KEY\b[^}]*\}\s*=\s*process\.env/,
    // An ALIASED environment. `process.env` is routinely passed down as `deps.env` / `opts.env`, and
    // reading the credential off the alias evades a `process.env`-only rule while breaking exactly
    // the invariant the rule exists to protect ("exactly one reader"). The CLI really did this:
    // `deps.env['DASHSCOPE_API_KEY']`, to feed the redactor. It now goes through the provider's
    // `EnvCredentialSource` instead, so the read still happens at the one permitted boundary.
    /\.env\s*\[\s*['"`]DASHSCOPE_API_KEY['"`]\s*\]/,
    /\.env\s*\.\s*DASHSCOPE_API_KEY\b/,
  ];
  for (const unit of units) {
    if (unit.kind === 'packages' && CREDENTIAL_OWNERS.has(unit.name)) continue;
    for (const file of unit.files) {
      const source = sources.get(file) ?? '';
      for (const pattern of ENV_READ_PATTERNS) {
        const m = pattern.exec(source);
        if (m) {
          failures.push({
            file: rel(file),
            line: lineOf(source, m.index),
            message: `${unit.kind}/${unit.name} READS ${CREDENTIAL_NAME} from the environment; only ${[...CREDENTIAL_OWNERS].join(' and ')} may read the credential value (threat model: exactly one reader). Naming the env var is fine; reading its value here is not.`,
          });
        }
      }
    }
  }
  results.push({
    id: '6',
    title: `${CREDENTIAL_NAME} value is read only by provider-dashscope and secret-store`,
    failures,
    warnings: [],
  });
}

// --- Rule 7: package shape (warnings) ---------------------------------------------------------
{
  const warnings: Finding[] = [];
  for (const unit of units) {
    if (!existsSync(join(unit.dir, 'README.md'))) {
      warnings.push({
        file: `${rel(unit.dir)}/README.md`,
        line: 0,
        message: `${unit.kind}/${unit.name} has no README.md`,
      });
    }
    if (!existsSync(join(unit.dir, 'src', 'index.ts'))) {
      warnings.push({
        file: `${rel(unit.dir)}/src/index.ts`,
        line: 0,
        message: `${unit.kind}/${unit.name} has no src/index.ts (not implemented yet)`,
      });
    }
  }
  results.push({
    id: '7',
    title: 'Every package has a README.md and a src/index.ts',
    failures: [],
    warnings,
  });
}

// --- Rule 8: file-size / complexity guardrail ------------------------------------------------
// A line ceiling is a coarse but MECHANICAL complexity guardrail: past a point a single file can no
// longer be reviewed or reasoned about as one unit and must be split. Files over the soft guideline
// are surfaced as warnings (split candidates); a file over the hard ceiling fails the gate outright,
// so no source file can grow without bound. `*.test.ts` is already excluded from `unit.files`.
{
  const SOFT_MAX = 900;
  const HARD_MAX = 2200;
  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  for (const unit of units) {
    for (const file of unit.files) {
      const lines = readFileSync(file, 'utf8').split('\n').length;
      if (lines > HARD_MAX) {
        failures.push({
          file: rel(file),
          line: 0,
          message: `${lines} lines exceeds the ${HARD_MAX}-line ceiling; split this file into cohesive modules`,
        });
      } else if (lines > SOFT_MAX) {
        warnings.push({
          file: rel(file),
          line: 0,
          message: `${lines} lines is over the ${SOFT_MAX}-line guideline — consider splitting`,
        });
      }
    }
  }
  results.push({
    id: '8',
    title: `File-size/complexity guardrail (warn > ${SOFT_MAX}, fail > ${HARD_MAX} lines)`,
    failures,
    warnings,
  });
}

// --- Rule 9: docs-link integrity -------------------------------------------------------------
// Every RELATIVE Markdown link in the documentation must resolve to a real file. A broken internal
// link is a silently-rotten doc, and the acceptance criteria require the documentation to be
// trustworthy. External (`http(s):`/`mailto:`) and pure-anchor links are out of scope for a
// filesystem check and are skipped.
{
  const failures: Finding[] = [];
  const mdFiles: string[] = [];
  const collectMd = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collectMd(full);
      else if (entry.endsWith('.md')) mdFiles.push(full);
    }
  };
  collectMd(join(REPO_ROOT, 'docs'));
  for (const entry of readdirSync(REPO_ROOT)) {
    if (entry.endsWith('.md')) mdFiles.push(join(REPO_ROOT, entry));
  }
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of mdFiles) {
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(source)) !== null) {
      const raw = (match[1] ?? '').split('#')[0].trim();
      if (raw === '' || /^(https?:|mailto:)/.test(raw)) continue;
      if (!existsSync(resolve(dirname(file), raw))) {
        failures.push({
          file: rel(file),
          line: lineOf(source, match.index),
          message: `broken link: ${match[1]} does not resolve to a file`,
        });
      }
    }
  }
  results.push({
    id: '9',
    title: 'Docs links resolve (no broken relative Markdown links)',
    failures,
    warnings: [],
  });
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const scannedFiles = units.reduce((total, unit) => total + unit.files.length, 0);
const emptyUnits = units.filter((unit) => unit.files.length === 0);

console.log('architecture gate  ·  scripts/graph.ts vs. the real import graph');
console.log(
  `  ${units.length} workspace units (${units.filter((u) => u.kind === 'packages').length} packages, ${units.filter((u) => u.kind === 'apps').length} apps)  ·  ${scannedFiles} source files scanned (*.test.ts excluded)`,
);
if (emptyUnits.length > 0) {
  console.log(
    `  ${emptyUnits.length} unit(s) have no source yet and were skipped: ${emptyUnits.map((u) => u.name).join(', ')}`,
  );
}
console.log('');

let failureCount = 0;
let warningCount = 0;

for (const result of results) {
  failureCount += result.failures.length;
  warningCount += result.warnings.length;
  const mark = result.failures.length === 0 ? '✓' : '✗';
  const suffix =
    result.failures.length === 0
      ? result.warnings.length > 0
        ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})`
        : ''
      : ` (${result.failures.length} violation${result.failures.length === 1 ? '' : 's'})`;
  console.log(`${mark} rule ${result.id}: ${result.title}${suffix}`);
  for (const failure of result.failures) {
    const where = failure.line > 0 ? `${failure.file}:${failure.line}` : failure.file;
    console.log(`    VIOLATION  ${where}`);
    console.log(`               ${failure.message}`);
  }
  for (const warning of result.warnings) {
    const where = warning.line > 0 ? `${warning.file}:${warning.line}` : warning.file;
    console.log(`    warning    ${where} — ${warning.message}`);
  }
}

console.log('');
if (failureCount > 0) {
  console.log(
    `✗ FAIL: ${failureCount} architecture violation${failureCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}.`,
  );
  console.log('  The dependency graph in scripts/graph.ts is the contract. Fix the code, or');
  console.log('  change the contract deliberately — never let them drift apart silently.');
  process.exit(1);
}

console.log(
  `✓ PASS: all 9 boundaries hold across ${scannedFiles} source files. ${warningCount} warning${warningCount === 1 ? '' : 's'} (non-fatal).`,
);
process.exit(0);
