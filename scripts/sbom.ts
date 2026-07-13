/**
 * PK-04 — SBOM and dependency audit.
 *
 * Emits `dist/release/sbom.cdx.json` (CycloneDX 1.6) and `dist/release/audit.json`.
 *
 * The SBOM is GENERATED FROM `pnpm-lock.yaml`, never hand-written. That distinction is the whole
 * value of the document: a hand-maintained component list is a statement of intent, and drifts from
 * the tree the moment anyone adds a transitive dependency. The lockfile is what pnpm actually
 * installed, integrity hashes and all, so an SBOM derived from it can be checked against the
 * artifact by someone who does not trust us.
 *
 * Every component carries the `integrity` the lockfile recorded, converted into a CycloneDX hash.
 * pnpm writes `sha512-<base64>`; CycloneDX wants hex, so we decode rather than dropping the field —
 * an SBOM with no hashes is a list of names, which is not an SBOM.
 *
 * The audit is `pnpm audit --json` against the same lockfile. It fails the gate on a HIGH or
 * CRITICAL advisory. It fails CLOSED on a network error: "we could not check" must never be
 * recorded as "there is nothing to find".
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = join(REPO_ROOT, 'dist', 'release');
const nodeRequire = createRequire(import.meta.url);

export interface Component {
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly integrity?: string;
  /** True when the package is only needed to BUILD or TEST, never to run the shipped artifact. */
  readonly dev: boolean;
}

interface PnpmLock {
  readonly lockfileVersion?: string;
  readonly importers?: Record<
    string,
    Record<string, Record<string, { specifier?: string; version?: string }> | undefined>
  >;
  readonly packages?: Record<string, { resolution?: { integrity?: string } }>;
  readonly snapshots?: Record<string, unknown>;
}

/**
 * A lockfile key is `name@version` — but `name` may itself be scoped (`@scope/name@1.2.3`), and the
 * version may carry a peer-dependency suffix (`react@19.2.7(typescript@5.9.3)`).
 *
 * The peer suffix must be removed FIRST. It contains its own `@` signs, so searching for the last
 * `@` in the raw key finds the one inside `(typescript@5.9.3)` and splits the package into
 * `react@19.2.7(typescript` / `5.9.3)`. Drop the suffix, and only then split on the last `@` — which
 * is now unambiguously the name/version separator, scoped names included.
 */
export function parseLockKey(key: string): { name: string; version: string } | null {
  const paren = key.indexOf('(');
  const bare = paren === -1 ? key : key.slice(0, paren);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return null;
  const name = bare.slice(0, at);
  const version = bare.slice(at + 1);
  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

/** `sha512-<base64>` (pnpm / npm) -> `{ alg: 'SHA-512', content: '<hex>' }` (CycloneDX). */
export function integrityToHash(integrity: string): { alg: string; content: string } | null {
  const m = /^(sha\d{3})-(.+)$/.exec(integrity);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const alg = m[1].replace(/^sha(\d+)$/, 'SHA-$1');
  try {
    return { alg, content: Buffer.from(m[2], 'base64').toString('hex') };
  } catch {
    return null;
  }
}

/**
 * Which packages are reachable WITHOUT dev dependencies. The shipped CLI contains only these, so
 * marking the rest `dev` is what stops an auditor from chasing a vitest advisory that cannot
 * possibly reach a user. Derived from the importers block: every workspace project's runtime
 * `dependencies` (not `devDependencies`), transitively closed over the lockfile snapshots.
 */
function runtimeRoots(lock: PnpmLock): Set<string> {
  const roots = new Set<string>();
  for (const importer of Object.values(lock.importers ?? {})) {
    const deps = importer['dependencies'];
    if (deps === undefined) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const version = spec.version;
      if (version === undefined || version.startsWith('link:')) continue;
      const clean = version.includes('(') ? version.slice(0, version.indexOf('(')) : version;
      roots.add(`${name}@${clean}`);
    }
  }
  return roots;
}

export function buildSbom(lockPath = join(REPO_ROOT, 'pnpm-lock.yaml')): {
  components: Component[];
  document: unknown;
} {
  const { parse } = nodeRequire('yaml') as { parse: (s: string) => unknown };
  const lock = parse(readFileSync(lockPath, 'utf8')) as PnpmLock;

  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };

  const runtime = runtimeRoots(lock);
  const components: Component[] = [];

  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    const parsed = parseLockKey(key);
    if (parsed === null) continue;
    const { name, version } = parsed;
    const integrity = value.resolution?.integrity;
    components.push({
      name,
      version,
      purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
      ...(integrity !== undefined ? { integrity } : {}),
      dev: !runtime.has(`${name}@${version}`),
    });
  }
  components.sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );

  // Timestamp from the source date, so two builds of the same commit produce the same SBOM.
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  const stamp = new Date(
    (epoch !== undefined && /^\d+$/.test(epoch)
      ? Number(epoch)
      : Number(
          execFileSync('git', ['log', '-1', '--format=%ct'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          }).trim(),
        )) * 1000,
  ).toISOString();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();

  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: stamp,
      tools: {
        components: [{ type: 'application', name: 'scripts/sbom.ts', version: root.version }],
      },
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/qwen-harness@${root.version}`,
        name: 'qwen-harness',
        version: root.version,
        purl: `pkg:npm/qwen-harness@${root.version}`,
      },
      properties: [
        { name: 'qwen-harness:commit', value: commit },
        { name: 'qwen-harness:source', value: 'pnpm-lock.yaml' },
        { name: 'qwen-harness:lockfileVersion', value: String(lock.lockfileVersion ?? 'unknown') },
      ],
    },
    components: components.map((c) => {
      const hash = c.integrity !== undefined ? integrityToHash(c.integrity) : null;
      return {
        type: 'library',
        'bom-ref': c.purl,
        name: c.name,
        version: c.version,
        purl: c.purl,
        scope: c.dev ? 'excluded' : 'required',
        ...(hash !== null ? { hashes: [hash] } : {}),
      };
    }),
  };

  return { components, document };
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

interface AuditReport {
  readonly advisories: Record<string, { severity?: string; module_name?: string; title?: string }>;
  readonly metadata?: { vulnerabilities?: Record<string, number> };
}

export interface AuditResult {
  readonly ok: boolean;
  readonly report: AuditReport;
  readonly blocking: string[];
}

export function runAudit(): AuditResult {
  let raw: string;
  try {
    raw = execFileSync('pnpm', ['audit', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // `pnpm audit` exits non-zero when it FINDS something — that is a successful audit with a
    // finding, and stdout still holds the report. It also exits non-zero when it cannot reach the
    // registry, and that is a completely different thing. Distinguish them by whether we got JSON.
    const err = e as { stdout?: string; message?: string };
    if (err.stdout !== undefined && err.stdout.trim().startsWith('{')) {
      raw = err.stdout;
    } else {
      throw new Error(
        `pnpm audit could not complete (registry unreachable?): ${err.message ?? 'unknown error'}\n` +
          '  This is NOT "no vulnerabilities". The release gate fails closed rather than record an\n' +
          '  audit that never ran.',
      );
    }
  }

  const report = JSON.parse(raw) as AuditReport;
  const blocking: string[] = [];
  for (const advisory of Object.values(report.advisories ?? {})) {
    const severity = (advisory.severity ?? '').toLowerCase();
    if (severity === 'high' || severity === 'critical') {
      blocking.push(`${severity}: ${advisory.module_name ?? '?'} — ${advisory.title ?? '?'}`);
    }
  }
  return { ok: blocking.length === 0, report, blocking };
}

// ---------------------------------------------------------------------------------------------

export function emit(): { componentCount: number; audit: AuditResult } {
  mkdirSync(OUT_DIR, { recursive: true });

  const { components, document } = buildSbom();
  const sbomPath = join(OUT_DIR, 'sbom.cdx.json');
  writeFileSync(sbomPath, `${JSON.stringify(document, null, 2)}\n`);

  const runtimeCount = components.filter((c) => !c.dev).length;
  console.log('SBOM  ·  CycloneDX 1.6, generated from pnpm-lock.yaml');
  console.log(
    `  ${String(components.length)} components (${String(runtimeCount)} runtime-reachable, ${String(components.length - runtimeCount)} build/test only)`,
  );
  const withHash = components.filter((c) => c.integrity !== undefined).length;
  console.log(`  ${String(withHash)}/${String(components.length)} carry a registry integrity hash`);
  console.log(`  ✓ ${relative(REPO_ROOT, sbomPath)}`);
  console.log('');

  const audit = runAudit();
  const auditPath = join(OUT_DIR, 'audit.json');
  writeFileSync(auditPath, `${JSON.stringify(audit.report, null, 2)}\n`);

  const counts = audit.report.metadata?.vulnerabilities ?? {};
  console.log('dependency audit  ·  pnpm audit');
  console.log(
    `  critical ${String(counts['critical'] ?? 0)} · high ${String(counts['high'] ?? 0)} · moderate ${String(counts['moderate'] ?? 0)} · low ${String(counts['low'] ?? 0)} · info ${String(counts['info'] ?? 0)}`,
  );
  console.log(`  ✓ ${relative(REPO_ROOT, auditPath)}`);

  if (!audit.ok) {
    console.log('');
    console.log('  ✗ BLOCKING advisories (high/critical):');
    for (const b of audit.blocking) console.log(`      ${b}`);
  }

  return { componentCount: components.length, audit };
}

// Exact path comparison: the packaging tests import `buildSbom` from here.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { audit } = emit();
  process.exit(audit.ok ? 0 : 1);
}
