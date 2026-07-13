import { describe, expect, it } from 'vitest';

import { isPairingIntact, reduceContext } from './reduction.ts';

/** Seeded LCG — property tests must be reproducible (house convention). */
class Rng {
  #state;
  constructor(seed) {
    this.#state = seed >>> 0;
  }
  next() {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return this.#state / 0x1_0000_0000;
  }
  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }
}

const msg = (text) => ({ type: 'message', role: 'assistant', text });
const call = (id) => ({ type: 'function-call', callId: id, name: 'read', argumentsJson: '{}' });
const out = (id, output = 'ok') => ({ type: 'function-output', callId: id, name: 'read', output });

const opts = { makeRefId: (_item, i) => `ref_${i}` };

describe('offload', () => {
  it('replaces a large old tool result with a bounded preview and a ref, keeping the item', () => {
    const big = 'y'.repeat(5000);
    const items = [msg('goal'), call('call_1'), out('call_1', big), msg('a'), msg('b'), msg('c')];
    const result = reduceContext(items, {
      ...opts,
      offloadThresholdChars: 2048,
      preserveRecent: 2,
    });

    expect(result.offloadedCount).toBe(1);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].ref).toBe('ref_2');
    // The output item survives (pairing intact) but its body is now the preview + pointer.
    const output = result.items.find((i) => i.type === 'function-output');
    expect(output.output).toContain('offloaded');
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.pairingIntact).toBe(true);
  });
});

describe('pruning safe middle content', () => {
  it('drops middle messages but preserves the first item and the recent tail', () => {
    const items = [msg('GOAL'), msg('mid-1'), msg('mid-2'), msg('recent-1'), msg('recent-2')];
    const result = reduceContext(items, { ...opts, preserveRecent: 2 });
    const texts = result.items.map((i) => i.text);
    expect(texts).toContain('GOAL');
    expect(texts).toContain('recent-1');
    expect(texts).toContain('recent-2');
    expect(texts).not.toContain('mid-1');
    expect(result.prunedCount).toBe(2);
  });
});

describe('target-driven pair dropping', () => {
  it('drops oldest complete pairs together and never orphans a result', () => {
    const items = [
      msg('goal'),
      call('a'),
      out('a', 'x'.repeat(100)),
      call('b'),
      out('b', 'x'.repeat(100)),
      msg('recent'),
    ];
    const result = reduceContext(items, {
      ...opts,
      preserveRecent: 1,
      offloadThresholdChars: 10_000, // do not offload; force pair-dropping instead
      targetTokens: 20,
    });
    expect(result.droppedPairCount).toBeGreaterThan(0);
    expect(result.pairingIntact).toBe(true);
    // No output remains whose call was dropped.
    expect(isPairingIntact(result.items)).toBe(true);
  });
});

describe('pairing invariant (property)', () => {
  it('never orphans a tool result across randomized interleavings', () => {
    const rng = new Rng(0xc0ffee);
    for (let trial = 0; trial < 200; trial += 1) {
      const items = [msg('goal')];
      const openCalls = [];
      let nextId = 0;
      const steps = 3 + rng.int(20);
      for (let s = 0; s < steps; s += 1) {
        const choice = rng.int(3);
        if (choice === 0) {
          items.push(msg(`m${s}`));
        } else if (choice === 1) {
          const id = `call_${nextId++}`;
          items.push(call(id));
          openCalls.push(id);
        } else if (openCalls.length > 0) {
          // Close a random open call, sometimes with a large body to trigger offload.
          const idx = rng.int(openCalls.length);
          const id = openCalls.splice(idx, 1)[0];
          items.push(out(id, rng.int(2) === 0 ? 'z'.repeat(4000) : 'ok'));
        }
      }
      // Sanity: the generated transcript is itself well-paired.
      expect(isPairingIntact(items)).toBe(true);

      const result = reduceContext(items, {
        ...opts,
        preserveRecent: rng.int(4),
        offloadThresholdChars: 2048,
        targetTokens: rng.int(50),
      });
      expect(result.pairingIntact).toBe(true);
      expect(isPairingIntact(result.items)).toBe(true);

      // Every surviving result still has its call present.
      const calls = new Set(
        result.items.filter((i) => i.type === 'function-call').map((i) => i.callId),
      );
      for (const item of result.items) {
        if (item.type === 'function-output') expect(calls.has(item.callId)).toBe(true);
      }
    }
  });
});
