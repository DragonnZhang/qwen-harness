import { describe, expect, it } from 'vitest';

import {
  allBlockersCompleted,
  blockersOf,
  blocksOf,
  detectCycle,
  newlyUnblocked,
  wouldCreateCycle,
  type DepEdge,
} from './dependencies.ts';

/** A seeded LCG so a property failure is reproducible, never a once-per-moon flake. */
class Rng {
  #state: number;
  constructor(seed: number) {
    this.#state = seed >>> 0;
  }
  next(): number {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return this.#state / 0x1_0000_0000;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

describe('dependency reasoning (WK-05)', () => {
  it('reports blockers and blocks from an edge set', () => {
    const edges: DepEdge[] = [
      { blockerId: 1, blockedId: 3 },
      { blockerId: 2, blockedId: 3 },
      { blockerId: 3, blockedId: 4 },
    ];
    expect(blockersOf(edges, 3).sort()).toEqual([1, 2]);
    expect(blocksOf(edges, 3)).toEqual([4]);
    expect(blockersOf(edges, 1)).toEqual([]);
  });

  it('detects a self-dependency and a direct back-edge as cycles', () => {
    expect(wouldCreateCycle([], 5, 5)).toBe(true);
    const edges: DepEdge[] = [{ blockerId: 1, blockedId: 2 }];
    // Adding 2 -> 1 closes 1 -> 2 -> 1.
    expect(wouldCreateCycle(edges, 2, 1)).toBe(true);
    // Adding 1 -> 3 does not.
    expect(wouldCreateCycle(edges, 1, 3)).toBe(false);
  });

  it('detects a longer transitive cycle', () => {
    const edges: DepEdge[] = [
      { blockerId: 1, blockedId: 2 },
      { blockerId: 2, blockedId: 3 },
    ];
    // 3 -> 1 would close 1 -> 2 -> 3 -> 1.
    expect(wouldCreateCycle(edges, 3, 1)).toBe(true);
    expect(detectCycle([...edges, { blockerId: 3, blockedId: 1 }])).not.toBeNull();
    expect(detectCycle(edges)).toBeNull();
  });

  it('computes only the genuinely newly-unblocked downstream tasks', () => {
    // 1 and 2 both block 3; 3 blocks 4.
    const edges: DepEdge[] = [
      { blockerId: 1, blockedId: 3 },
      { blockerId: 2, blockedId: 3 },
      { blockerId: 3, blockedId: 4 },
    ];
    const status = new Map<number, string>([
      [1, 'completed'],
      [2, 'in-progress'],
      [3, 'blocked'],
      [4, 'blocked'],
    ]);
    // Completing 1 does NOT unblock 3, because 2 is still incomplete.
    expect(
      newlyUnblocked(
        edges,
        1,
        (id) => status.get(id) === 'blocked',
        (id) => status.get(id) === 'completed',
      ),
    ).toEqual([]);

    // Now 2 completes as well: completing 2 unblocks 3 (all of 3's blockers are done), but not 4.
    status.set(2, 'completed');
    expect(
      newlyUnblocked(
        edges,
        2,
        (id) => status.get(id) === 'blocked',
        (id) => status.get(id) === 'completed',
      ),
    ).toEqual([3]);
  });

  it('treats a task with no blockers as trivially satisfied', () => {
    expect(allBlockersCompleted([], 7, () => false)).toBe(true);
  });

  /**
   * Property: a graph built by only ever adding edges that `wouldCreateCycle` rejected as SAFE
   * stays acyclic — `detectCycle` (an independent DFS oracle) must never find a cycle in it. And any
   * edge `wouldCreateCycle` flags as unsafe must, when added, actually create one. 400 random runs.
   */
  it('property: wouldCreateCycle agrees with the independent cycle oracle', () => {
    const rng = new Rng(0x7a5c);
    for (let run = 0; run < 400; run += 1) {
      const nodeCount = 2 + rng.int(8);
      const edges: DepEdge[] = [];
      const attempts = rng.int(20);
      for (let i = 0; i < attempts; i += 1) {
        const blockerId = rng.int(nodeCount);
        const blockedId = rng.int(nodeCount);
        const flagged = wouldCreateCycle(edges, blockerId, blockedId);
        const withEdge = [...edges, { blockerId, blockedId }];
        const createsCycle = detectCycle(withEdge) !== null;
        // The predicate and the oracle must agree on whether this edge introduces a cycle.
        expect(flagged).toBe(createsCycle);
        if (!flagged) edges.push({ blockerId, blockedId });
      }
      // Everything we actually kept is acyclic.
      expect(detectCycle(edges)).toBeNull();
    }
  });
});
