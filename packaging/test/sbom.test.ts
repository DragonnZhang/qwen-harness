/**
 * PK-04 — the SBOM must describe the tree that actually exists.
 *
 * The failure mode an SBOM test has to guard against is not "the JSON is malformed" — it is "the
 * SBOM is a plausible-looking document that no longer matches the lockfile". So these tests read the
 * REAL `pnpm-lock.yaml` and check the generated document against facts that are independently true:
 * the frozen versions from ADR 0002, and the integrity hashes pnpm itself recorded.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildSbom, integrityToHash, parseLockKey } from '../../scripts/sbom.ts';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

describe('parseLockKey', () => {
  it('splits an unscoped package', () => {
    expect(parseLockKey('esbuild@0.25.10')).toEqual({ name: 'esbuild', version: '0.25.10' });
  });

  it('splits a SCOPED package — the leading @ is not the separator', () => {
    expect(parseLockKey('@types/node@24.10.1')).toEqual({
      name: '@types/node',
      version: '24.10.1',
    });
  });

  it('drops the peer-dependency suffix pnpm appends', () => {
    expect(parseLockKey('react@19.2.7(typescript@5.9.3)')).toEqual({
      name: 'react',
      version: '19.2.7',
    });
  });

  it('rejects a key with no version', () => {
    expect(parseLockKey('bare')).toBeNull();
  });
});

describe('integrityToHash', () => {
  it('converts pnpm base64 integrity to CycloneDX hex', () => {
    const hash = integrityToHash('sha512-3q2+7w==');
    expect(hash).not.toBeNull();
    expect(hash!.alg).toBe('SHA-512');
    // deadbeef, the bytes that base64 string actually encodes.
    expect(hash!.content).toBe('deadbeef');
  });

  it('returns null on something that is not an integrity string', () => {
    expect(integrityToHash('not-an-integrity')).toBeNull();
  });
});

describe('the SBOM built from the real pnpm-lock.yaml', () => {
  const { components, document } = buildSbom();
  const doc = document as {
    bomFormat: string;
    specVersion: string;
    metadata: { component: { name: string }; properties: { name: string; value: string }[] };
    components: {
      name: string;
      version: string;
      hashes?: { alg: string; content: string }[];
      scope: string;
    }[];
  };

  it('is a CycloneDX 1.6 document naming this product', () => {
    expect(doc.bomFormat).toBe('CycloneDX');
    expect(doc.specVersion).toBe('1.6');
    expect(doc.metadata.component.name).toBe('qwen-harness');
    expect(doc.metadata.properties.find((p) => p.name === 'qwen-harness:source')?.value).toBe(
      'pnpm-lock.yaml',
    );
  });

  it('is not empty, and is not a hand-written stub', () => {
    // The real tree has hundreds of packages. A dozen would mean someone had "simplified" this.
    expect(components.length).toBeGreaterThan(100);
  });

  it('contains the exact frozen versions from ADR 0002', () => {
    // If any of these drift, either the ADR or the lockfile is wrong — and this test says which.
    const expected: Record<string, string> = {
      typescript: '5.9.3',
      vitest: '4.1.10',
      zod: '4.4.3',
      'better-sqlite3': '12.11.1',
      prettier: '3.9.5',
    };
    for (const [name, version] of Object.entries(expected)) {
      const found = components.filter((c) => c.name === name);
      expect(found.length, `${name} is absent from the SBOM`).toBeGreaterThan(0);
      expect(
        found.map((c) => c.version),
        `${name} should be pinned at ${version} (ADR 0002)`,
      ).toContain(version);
    }
  });

  it('every component carries a real integrity hash from the lockfile', () => {
    const withHash = doc.components.filter((c) => (c.hashes?.length ?? 0) > 0);
    // pnpm records `integrity` for every registry tarball. A few link:/file: entries legitimately
    // have none, so we require the overwhelming majority rather than all.
    expect(withHash.length / doc.components.length).toBeGreaterThan(0.95);
    for (const c of withHash.slice(0, 50)) {
      expect(c.hashes![0]!.alg).toMatch(/^SHA-\d+$/);
      expect(c.hashes![0]!.content).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('distinguishes what ships from what only builds', () => {
    const runtime = components.filter((c) => !c.dev);
    const dev = components.filter((c) => c.dev);
    expect(runtime.length).toBeGreaterThan(0);
    expect(dev.length).toBeGreaterThan(0);

    // better-sqlite3 and zod are in the shipped CLI; vitest and prettier could not possibly be.
    expect(runtime.map((c) => c.name)).toContain('better-sqlite3');
    expect(runtime.map((c) => c.name)).toContain('zod');
    expect(dev.map((c) => c.name)).toContain('vitest');
    expect(dev.map((c) => c.name)).toContain('prettier');
  });

  it('the component list agrees with the lockfile it claims to come from', () => {
    // Independent check: count the `packages:` entries in the raw YAML text and compare. If the
    // parser silently dropped a section, this catches it without trusting the parser.
    const raw = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    const packagesBlock = raw.slice(raw.indexOf('\npackages:'), raw.indexOf('\nsnapshots:'));
    const keys = [...packagesBlock.matchAll(/^ {2}(\S.*?):$/gm)].length;
    expect(components.length).toBe(keys);
  });
});
