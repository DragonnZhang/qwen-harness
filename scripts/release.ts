/**
 * PK-04 — build every release artifact, and prove the build is reproducible.
 *
 * Run with `pnpm release`. Produces, under `dist/release/`:
 *
 *   qwen-harness-<version>.tgz          the installable CLI package (PK-02)
 *   qwen-harness-<version>.tgz.sha256   its digest
 *   sbom.cdx.json                       CycloneDX SBOM, generated from pnpm-lock.yaml
 *   audit.json                          pnpm audit, failing the gate on high/critical
 *   RELEASE.txt                         the artifact index, with every digest
 *
 * Reproducibility is DEMONSTRATED, not asserted: the package is built twice, into two different
 * output paths, and the two digests are compared. "Reproducible" is a property of the build that
 * either holds today or does not, and the only way to know is to do it twice and look. A build that
 * has quietly become non-reproducible (someone embedded `Date.now()`, or a directory listing leaked
 * in unsorted) fails here, on the release, rather than being discovered by someone who cannot
 * reproduce our artifact and has to decide whether to trust it.
 *
 * The changelog and migration notes are NOT generated: they are human documents in `docs/release/`,
 * and this script verifies that the version being built has an entry in the changelog rather than
 * writing one for it. A generated changelog is a git log with extra steps.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from './package-cli.ts';
import { emit as emitSbomAndAudit } from './sbom.ts';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = join(REPO_ROOT, 'dist', 'release');
const CHANGELOG = join(REPO_ROOT, 'docs', 'release', 'CHANGELOG.md');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rule(title: string): void {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}`);
  console.log('');
}

export function release(options: { allowDirty?: boolean } = {}): number {
  const version = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;

  // A release with no changelog entry is a release nobody can read. Check before spending two
  // minutes building artifacts for it.
  rule('changelog');
  if (!existsSync(CHANGELOG)) {
    console.error(`  ✗ ${relative(REPO_ROOT, CHANGELOG)} does not exist.`);
    return 1;
  }
  const changelog = readFileSync(CHANGELOG, 'utf8');
  if (!changelog.includes(`## ${version}`)) {
    console.error(`  ✗ ${relative(REPO_ROOT, CHANGELOG)} has no "## ${version}" section.`);
    console.error(
      '    Write the entry before cutting the release; a generated one would say nothing.',
    );
    return 1;
  }
  console.log(`  ✓ ${relative(REPO_ROOT, CHANGELOG)} documents ${version}`);

  rule('package (build 1 of 2)');
  const first = buildPackage(options);
  const firstCopy = join(OUT_DIR, `.repro-first-${version}.tgz`);
  copyFileSync(first.tarball, firstCopy);

  rule('package (build 2 of 2 — reproducibility check)');
  const second = buildPackage(options);

  rule('reproducibility');
  const a = sha256(firstCopy);
  const b = sha256(second.tarball);
  rmSync(firstCopy, { force: true });
  if (a !== b) {
    console.error('  ✗ NOT REPRODUCIBLE: two builds of the same commit produced different bytes.');
    console.error(`      build 1  ${a}`);
    console.error(`      build 2  ${b}`);
    console.error('    Something in the build depends on the wall clock, the filesystem order, or');
    console.error(
      '    the environment. The artifact cannot be independently verified until it does not.',
    );
    return 1;
  }
  console.log('  ✓ two independent builds of this commit produced byte-identical tarballs');
  console.log(`    sha256 ${a}`);

  rule('SBOM and dependency audit');
  const { audit, componentCount } = emitSbomAndAudit();
  if (!audit.ok) {
    console.error('');
    console.error(
      '  ✗ the dependency audit found high or critical advisories; the release is blocked.',
    );
    return 1;
  }

  rule('artifacts');
  const artifacts = [
    `qwen-harness-${version}.tgz`,
    `qwen-harness-${version}.tgz.sha256`,
    'sbom.cdx.json',
    'audit.json',
  ];
  const lines: string[] = [
    `qwen-harness ${version}`,
    '',
    'Artifacts and their SHA-256 digests. The tarball is reproducible: rebuilding this commit with',
    'the same SOURCE_DATE_EPOCH yields the identical bytes and therefore the identical digest.',
    '',
  ];
  for (const name of artifacts) {
    const path = join(OUT_DIR, name);
    if (!existsSync(path)) continue;
    const digest = sha256(path);
    lines.push(`${digest}  ${name}`);
    console.log(`  ${digest}  ${name}`);
  }
  lines.push('');
  lines.push(`SBOM components: ${String(componentCount)} (from pnpm-lock.yaml)`);
  lines.push('Verify an install with: packaging/install.sh verify --prefix <prefix>');
  lines.push('');
  writeFileSync(join(OUT_DIR, 'RELEASE.txt'), lines.join('\n'));
  console.log(`  ${sha256(join(OUT_DIR, 'RELEASE.txt'))}  RELEASE.txt`);

  rule('done');
  console.log(`  ✓ qwen-harness ${version} — reproducible package, SBOM, clean audit.`);
  console.log(`    ${relative(REPO_ROOT, OUT_DIR)}/`);
  console.log('');
  console.log('    Nothing was published. Publishing is a deliberate, separate act.');
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT_DIR, { recursive: true });
  process.exit(release({ allowDirty: process.argv.includes('--allow-dirty') }));
}
