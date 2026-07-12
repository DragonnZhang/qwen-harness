import type { ToolCallId } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import type { ToolAnnotations } from './contract.ts';
import { conflicts, planBatches, type PlannedCall } from './scheduler.ts';

const READ_ONLY: ToolAnnotations = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};
const MUTATING: ToolAnnotations = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: false,
};

let n = 0;
function call(
  toolName: string,
  opts: {
    reads?: string[];
    writes?: string[];
    unbounded?: boolean;
    annotations?: ToolAnnotations;
  } = {},
): PlannedCall {
  return {
    callId: `call_${String(++n).padStart(6, '0')}` as ToolCallId,
    toolName,
    annotations: opts.annotations ?? (opts.writes?.length || opts.unbounded ? MUTATING : READ_ONLY),
    footprint: {
      reads: opts.reads ?? [],
      writes: opts.writes ?? [],
      unbounded: opts.unbounded ?? false,
    },
  };
}

const OPTS = { maxParallel: 8 };

describe('conflict detection is based on ARGUMENTS, not on tool names', () => {
  it('two reads of the same file do not conflict', () => {
    expect(
      conflicts(call('read', { reads: ['/w/a.ts'] }), call('read', { reads: ['/w/a.ts'] })),
    ).toBe(false);
  });

  it('two writes to DIFFERENT files do not conflict as resources', () => {
    // They will still be serialized (a mutation never shares a batch), but the *resource* check
    // itself must not claim a conflict — otherwise the reason in the audit trail would be wrong.
    expect(
      conflicts(call('write', { writes: ['/w/a.ts'] }), call('write', { writes: ['/w/b.ts'] })),
    ).toBe(false);
  });

  it('two writes to the SAME file conflict', () => {
    expect(
      conflicts(call('write', { writes: ['/w/a.ts'] }), call('write', { writes: ['/w/a.ts'] })),
    ).toBe(true);
  });

  it('a read conflicts with a concurrent write to the same path — in both orders', () => {
    const reader = call('read', { reads: ['/w/a.ts'] });
    const writer = call('write', { writes: ['/w/a.ts'] });
    expect(conflicts(reader, writer)).toBe(true);
    expect(conflicts(writer, reader)).toBe(true);
  });

  it('an unbounded call conflicts with EVERYTHING', () => {
    // An arbitrary shell command could touch anything. We cannot reason about its footprint, so
    // we never let it run beside another call. Conservative on purpose.
    const shell = call('shell', { unbounded: true });
    expect(conflicts(shell, call('read', { reads: ['/w/unrelated.ts'] }))).toBe(true);
    expect(conflicts(call('read', { reads: ['/w/unrelated.ts'] }), shell)).toBe(true);
  });
});

describe('planBatches', () => {
  it('runs independent reads in ONE parallel batch', () => {
    const calls = [
      call('read', { reads: ['/w/a.ts'] }),
      call('read', { reads: ['/w/b.ts'] }),
      call('grep', { reads: ['/w/c.ts'] }),
    ];
    const batches = planBatches(calls, OPTS);

    expect(batches).toHaveLength(1);
    expect(batches[0]!.kind).toBe('parallel');
    expect(batches[0]!.calls).toHaveLength(3);
  });

  it('serializes every mutation, even to different files', () => {
    const calls = [call('write', { writes: ['/w/a.ts'] }), call('write', { writes: ['/w/b.ts'] })];
    const batches = planBatches(calls, OPTS);

    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.kind === 'serial')).toBe(true);
  });

  it('preserves ORIGINAL ORDER across batches', () => {
    // The model emitted: read a, write a, read a. The second read must see the write.
    // If we hoisted both reads into one parallel batch, it would not.
    const r1 = call('read', { reads: ['/w/a.ts'] });
    const w = call('write', { writes: ['/w/a.ts'] });
    const r2 = call('read', { reads: ['/w/a.ts'] });

    const batches = planBatches([r1, w, r2], OPTS);
    const order = batches.flatMap((b) => b.calls.map((c) => c.callId));

    expect(order).toEqual([r1.callId, w.callId, r2.callId]);
    expect(batches).toHaveLength(3);
    expect(batches[1]!.kind).toBe('serial');
  });

  it('splits a parallel batch the moment a conflict appears', () => {
    const a = call('read', { reads: ['/w/a.ts'] });
    const b = call('read', { reads: ['/w/b.ts'] });
    const w = call('write', { writes: ['/w/b.ts'] });
    const c = call('read', { reads: ['/w/c.ts'] });

    const batches = planBatches([a, b, w, c], OPTS);

    expect(batches[0]).toMatchObject({ kind: 'parallel' });
    expect(batches[0]!.calls.map((x) => x.callId)).toEqual([a.callId, b.callId]);
    expect(batches[1]).toMatchObject({ kind: 'serial' });
    expect(batches[1]!.calls.map((x) => x.callId)).toEqual([w.callId]);
    expect(batches[2]!.calls.map((x) => x.callId)).toEqual([c.callId]);
  });

  it('never exceeds maxParallel in one batch', () => {
    const calls = Array.from({ length: 20 }, (_, i) => call('read', { reads: [`/w/${i}.ts`] }));
    const batches = planBatches(calls, { maxParallel: 8 });

    for (const b of batches) expect(b.calls.length).toBeLessThanOrEqual(8);
    // Nothing is lost or duplicated.
    expect(batches.flatMap((b) => b.calls)).toHaveLength(20);
  });

  it('isolates an unbounded shell call into its own serial batch', () => {
    const a = call('read', { reads: ['/w/a.ts'] });
    const sh = call('shell', { unbounded: true });
    const b = call('read', { reads: ['/w/b.ts'] });

    const batches = planBatches([a, sh, b], OPTS);

    expect(batches).toHaveLength(3);
    expect(batches[1]!.kind).toBe('serial');
    expect(batches[1]!.calls[0]!.toolName).toBe('shell');
  });

  it('loses no call, whatever the mix', () => {
    const calls = [
      call('read', { reads: ['/w/a'] }),
      call('write', { writes: ['/w/a'] }),
      call('shell', { unbounded: true }),
      call('read', { reads: ['/w/b'] }),
      call('read', { reads: ['/w/c'] }),
      call('write', { writes: ['/w/c'] }),
    ];
    const batches = planBatches(calls, OPTS);
    const planned = batches.flatMap((b) => b.calls.map((c) => c.callId));

    expect(planned).toEqual(calls.map((c) => c.callId));
    expect(new Set(planned).size).toBe(calls.length);
  });
});
