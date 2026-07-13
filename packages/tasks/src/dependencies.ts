/**
 * Pure dependency-graph reasoning for the durable task graph (WK-05). Everything here operates on
 * plain edge lists so it can be property-tested exhaustively without a database.
 *
 * An edge `{ blockerId, blockedId }` reads "blockerId must complete before blockedId may begin".
 * The graph of these edges must stay acyclic: a cycle would mean a set of tasks that can never
 * start because each waits on another. Cycles and dangling references are rejected at creation and
 * at link time (WK-05).
 */

export interface DepEdge {
  readonly blockerId: number;
  readonly blockedId: number;
}

/** The tasks that must complete before `id` can begin. */
export function blockersOf(edges: readonly DepEdge[], id: number): number[] {
  return edges.filter((e) => e.blockedId === id).map((e) => e.blockerId);
}

/** The tasks that are waiting on `id`. */
export function blocksOf(edges: readonly DepEdge[], id: number): number[] {
  return edges.filter((e) => e.blockerId === id).map((e) => e.blockedId);
}

/** Adjacency in the direction of the constraint: blocker -> [blocked, ...]. */
function successors(edges: readonly DepEdge[]): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    const list = adj.get(e.blockerId) ?? [];
    list.push(e.blockedId);
    adj.set(e.blockerId, list);
  }
  return adj;
}

/** Can `target` be reached from `start` by following blocker -> blocked edges? */
function reachable(edges: readonly DepEdge[], start: number, target: number): boolean {
  const adj = successors(edges);
  const seen = new Set<number>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) {
      if (next === target) return true;
      stack.push(next);
    }
  }
  return false;
}

/**
 * Would adding `blocker -> blocked` close a cycle? True when `blocked` already reaches `blocker`
 * (so the new edge would complete a loop) or the edge is a self-dependency. This is the check run
 * BEFORE an edge is ever persisted, so the stored graph is acyclic by construction.
 */
export function wouldCreateCycle(
  edges: readonly DepEdge[],
  blockerId: number,
  blockedId: number,
): boolean {
  if (blockerId === blockedId) return true;
  return reachable(edges, blockedId, blockerId);
}

/**
 * Full-graph cycle detection (DFS with a recursion stack). Returns one cycle as a node path
 * `a -> b -> a`, or null if the graph is acyclic. Used to validate a batch of new edges at once
 * and as the oracle for property tests.
 */
export function detectCycle(edges: readonly DepEdge[]): number[] | null {
  const adj = successors(edges);
  const nodes = new Set<number>();
  for (const e of edges) {
    nodes.add(e.blockerId);
    nodes.add(e.blockedId);
  }

  const state = new Map<number, 'open' | 'done'>();
  const stack: number[] = [];

  const visit = (node: number): number[] | null => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === 'open') {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (state.get(next) === undefined) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };

  for (const node of [...nodes].sort((a, b) => a - b)) {
    if (state.get(node) === undefined) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Are ALL of `id`'s blockers completed? A task with no blockers is trivially unblocked (WK-05). */
export function allBlockersCompleted(
  edges: readonly DepEdge[],
  id: number,
  isCompleted: (blockerId: number) => boolean,
): boolean {
  return blockersOf(edges, id).every(isCompleted);
}

/**
 * After `completedId` completes, which downstream tasks just became runnable? Exactly the tasks
 * that (a) depend on `completedId`, (b) are currently `blocked`, and (c) now have every blocker
 * completed. This is what "completing upstream reports newly unblocked work" returns (WK-05).
 */
export function newlyUnblocked(
  edges: readonly DepEdge[],
  completedId: number,
  isBlocked: (id: number) => boolean,
  isCompleted: (id: number) => boolean,
): number[] {
  const candidates = blocksOf(edges, completedId);
  const unblocked = candidates.filter(
    (id) => isBlocked(id) && allBlockersCompleted(edges, id, isCompleted),
  );
  // Deterministic, de-duplicated order.
  return [...new Set(unblocked)].sort((a, b) => a - b);
}
