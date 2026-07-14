/**
 * SB-02 (P) — the sandbox write boundary as a generative property against REAL bubblewrap.
 *
 * Invariant: for ANY path string a tool could pass (benign relative, `..`-traversal, absolute
 * system path, unicode-laden), a process inside the sandbox that tries to CREATE a file at that
 * path can never make that file appear on the host filesystem OUTSIDE the bound workspace/scratch
 * roots. A write either fails, or lands on an ephemeral in-sandbox tmpfs the host cannot see, or
 * lands inside the workspace/scratch — never anywhere else on the host.
 *
 * This is a behavioral property: every generated case SPAWNS a real bwrap child and the assertion
 * is made on the real host filesystem afterward, not on path algebra. (The pure path-algebra
 * property lives in tool-worker's `resolve-scoped.property.test.ts`; this one attacks the kernel.)
 *
 * Non-vacuity is proven two ways below: the generator provably produces genuine escape attempts
 * (counted), and at least one benign write provably SUCCEEDS — so the property is not passing just
 * because every write happens to fail.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BubblewrapBackend } from '../../src/backend.ts';
import { CAP, NODE, makeWorkspace, specFor, type Workspace } from './helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace();
  // Pre-create nested dirs so benign nested writes can actually succeed (writeFileSync does not
  // create parents) — this is what makes the "allow" direction of the property non-vacuous.
  mkdirSync(join(ws.workspace, 'sub'), { recursive: true });
  mkdirSync(join(ws.workspace, 'a', 'b', 'c'), { recursive: true });
});
afterEach(() => ws.cleanup());

it('bubblewrap is available on this host (precondition for the fuzz property)', () => {
  expect(CAP.available).toBe(true);
});

// Shape = the directory prefix prepended to a unique canary basename. A leading '/' makes it an
// absolute smuggle; a '../' makes it a traversal; otherwise it stays inside the workspace.
const BENIGN_PREFIXES = ['', 'sub/', 'a/b/c/'] as const;
const TRAVERSAL_PREFIXES = ['../', '../../', '../../../', '../../../../'] as const;
const ABSOLUTE_PREFIXES = ['/tmp/', '/etc/', '/root/', '/dev/shm/', '/usr/', '/proc/'] as const;

// Unicode / control / dot-segment nested prefixes — adversarial names that stay relative.
const unicodeSeg = fc.constantFrom('café', 'é', '‮', 'ﬁle', 'a b', '...', '.git', 'sub');
const unicodePrefix = fc
  .array(unicodeSeg, { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join('/') + '/');

const prefixArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...BENIGN_PREFIXES) },
  { weight: 3, arbitrary: fc.constantFrom(...TRAVERSAL_PREFIXES) },
  { weight: 3, arbitrary: fc.constantFrom(...ABSOLUTE_PREFIXES) },
  { weight: 1, arbitrary: unicodePrefix },
);

/** A prefix is an escape attempt if it is absolute or ascends out of the workspace. */
function isEscape(prefix: string): boolean {
  return prefix.startsWith('/') || prefix.split('/').includes('..');
}

/** A prefix is benign-contained if it stays relative and never ascends. */
function isBenign(prefix: string): boolean {
  return !prefix.startsWith('/') && !prefix.split('/').includes('..');
}

// Host locations that a broken sandbox could leak a write into. None of these is bound writable, so
// a working sandbox leaves every one of them clean.
function externalHostTargets(name: string): string[] {
  return [
    join('/tmp', name),
    join('/etc', name),
    join('/root', name),
    join('/dev/shm', name),
    join(ws.root, name), // the parent of the bound mounts, on the host
    join(ws.root, 'outside', name),
  ];
}

describe('SB-02 (P): a sandboxed write never escapes to the host outside the workspace', () => {
  it('property: no generated path can create a host file outside workspace/scratch', async () => {
    const runId = randomUUID().slice(0, 8);
    let caseNo = 0;
    let escapeAttempts = 0;
    let deniedEscapes = 0; // escape whose write reported failure inside the sandbox
    let successfulBenign = 0; // benign write that really landed in the workspace on the host

    await fc.assert(
      fc.asyncProperty(prefixArb, async (prefix) => {
        const n = caseNo++;
        const name = `qh-fuzz-${runId}-${n}.txt`;
        const content = `QH-CANARY-${runId}-${n}`;
        const target = prefix + name;

        const script =
          "const fs=require('fs');try{fs.writeFileSync(process.argv[1],process.argv[2]);" +
          "console.log('WROTE-OK')}catch(e){console.log('FAIL:'+e.code)}";
        const r = await backend.run(
          specFor(ws, { command: NODE, args: ['-e', script, target, content] }),
        );
        const wrote = r.stdout.includes('WROTE-OK');

        // THE INVARIANT: the canary never appears at any external host location. This holds whether
        // the write failed (ENOENT/EROFS) or "succeeded" onto an ephemeral in-sandbox tmpfs.
        for (const p of externalHostTargets(name)) {
          expect(
            existsSync(p),
            `sandbox write escaped to host path ${p} — REAL SANDBOX ESCAPE`,
          ).toBe(false);
        }

        if (isEscape(prefix)) {
          escapeAttempts++;
          if (!wrote) deniedEscapes++;
        }
        if (isBenign(prefix) && wrote) {
          // A benign success must be a REAL file inside the workspace on the host.
          expect(existsSync(join(ws.workspace, prefix, name))).toBe(true);
          successfulBenign++;
        }
      }),
      { numRuns: 40, seed: 20260714 },
    );

    // Non-vacuity, proven from the run itself: the corpus really did attempt escapes AND at least
    // one of them was denied, and at least one benign write really succeeded.
    expect(
      escapeAttempts,
      'the generator produced no escape attempts — property is vacuous',
    ).toBeGreaterThan(5);
    expect(
      deniedEscapes,
      'no escape write was ever denied — property proves nothing',
    ).toBeGreaterThan(0);
    expect(
      successfulBenign,
      'no benign write ever succeeded — the sandbox may be failing everything',
    ).toBeGreaterThan(0);
  });

  it('the generator provably produces genuine escape attempts (non-vacuity, deterministic)', () => {
    // Independent of any spawn: sample the generator and classify. Both buckets must be populated,
    // or the property above would be attacking a corpus with no real escapes in it.
    const samples = fc.sample(prefixArb, { numRuns: 500, seed: 12345 });
    const escapes = samples.filter(isEscape).length;
    const benign = samples.filter(isBenign).length;
    expect(escapes).toBeGreaterThan(50);
    expect(benign).toBeGreaterThan(50);
  });
});
