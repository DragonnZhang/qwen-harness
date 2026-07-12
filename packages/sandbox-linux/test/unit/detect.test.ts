/**
 * Capability detection and backend selection. `detect()` must report the TRUTH about this host —
 * bwrap IS present here (checkpoint 00) — and a safe mode must fail CLOSED when it is not.
 */

import { describe, expect, it } from 'vitest';

import { BubblewrapBackend, DisabledBackend, selectBackend } from '../../src/backend.ts';
import { detectCapability, findPrlimit } from '../../src/capability.ts';

describe('detectCapability on this host', () => {
  const cap = detectCapability();

  it('reports bubblewrap as available (it is installed and functional here)', () => {
    expect(cap.available).toBe(true);
    expect(cap.backend).toBe('bubblewrap');
    expect(cap.bwrapPath).toMatch(/bwrap$/);
    expect(cap.reason).toBeNull();
  });

  it('runs a real bwrap smoke probe, not just a which(1)', () => {
    const runtime = cap.probes.find((p) => p.name === 'runtime-probe');
    expect(runtime?.ok).toBe(true);
  });

  it('locates prlimit for rlimit enforcement', () => {
    expect(findPrlimit()).toMatch(/prlimit$/);
    expect(cap.prlimitPath).toMatch(/prlimit$/);
  });
});

describe('selectBackend', () => {
  it('returns the real backend for a safe mode when bwrap is available', () => {
    const backend = selectBackend('workspace-write', { audit: { isolationDisabled: () => {} } });
    expect(backend.kind).toBe('bubblewrap');
    expect(backend).toBeInstanceOf(BubblewrapBackend);
  });

  it('returns the disabled backend for yolo, and records the choice', () => {
    let recorded = false;
    const backend = selectBackend('disabled', {
      audit: {
        isolationDisabled: () => {
          recorded = true;
        },
      },
    });
    expect(backend.kind).toBe('disabled');
    expect(backend).toBeInstanceOf(DisabledBackend);
    // The record happens at run time, not selection time — but the sink is wired in.
    expect(recorded).toBe(false);
  });

  it('disabled backend reports isolation is OFF via detect() (doctor honesty)', () => {
    const backend = new DisabledBackend({ isolationDisabled: () => {} });
    const cap = backend.detect();
    expect(cap.detail).toMatch(/disabled/i);
    expect(cap.probes[0]?.ok).toBe(false);
  });
});
