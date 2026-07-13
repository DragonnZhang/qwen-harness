// Recovery golden-path child process (checkpoint 10, path 2).
//
// This is NOT a test file — vitest's e2e project only picks up `*.test.ts`, and tsc ignores
// `.mjs`. It is a REAL runtime process that `recovery.test.ts` spawns and then SIGKILLs, so the
// golden path can prove crash-safety with an actual kill rather than an in-process assertion.
//
// It drives the SAME durable side-effect ledger the runtime uses (`@qwen-harness/storage`,
// resolved to the built package via `evals/node_modules`). The "side effect" is an increment of a
// counter file — exactly the "counter file that proves the side effect executed exactly once"
// the checkpoint calls for. The ordering it writes is the production ordering:
//
//     side-effect-intent  ->  mayExecute guard  ->  side-effect-started  ->  DO IT  ->  settled
//
// Modes:
//   complete               run the whole thing and settle known-complete, then exit 0.
//   crash-after-increment  intent + started + INCREMENT, signal ready, then hang forever. The
//                          parent SIGKILLs us here: the ledger is left `in-flight`, the counter
//                          shows 1, and `settled` was never written.
//   crash-before-increment intent + started, signal ready, then hang. Killed before the increment:
//                          `in-flight`, counter shows 0. Still `indeterminate` on recovery — the
//                          ledger cannot know we didn't do it, so it must refuse to blind-replay.
//   skip-if-done           intent only; if the ledger already forbids execution, exit 3 WITHOUT
//                          incrementing. Proves a fresh process honours a known-complete row.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { EventStore } from '@qwen-harness/storage';

const [, , dbPath, counterPath, readyPath, mode, key, threadId] = process.argv;

let counter = 0;
const ids = { next: (prefix) => `${prefix}_${String(++counter).padStart(6, '0')}` };
const clock = { now: () => 1_700_000_000_000 };

const store = new EventStore({ path: dbPath, clock, ids });

const base = {
  threadId,
  turnId: 'trn_worker01',
  correlationId: 'cor_worker01',
  permissionProfile: 'yolo',
  actor: { kind: 'system', id: 'act_worker1' },
};

// The thread row must exist before a projection can attach to it.
if (!store.getThread(threadId)) {
  store.append({
    threadId,
    turnId: null,
    correlationId: 'cor_worker01',
    permissionProfile: 'yolo',
    actor: { kind: 'user', id: 'act_user01' },
    payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
  });
}

const sideEffectId = ids.next('sfx');
store.append({
  ...base,
  payload: {
    type: 'side-effect-intent',
    intent: {
      sideEffectId,
      idempotencyKey: key,
      kind: 'other',
      destructive: true,
      normalizedAction: 'increment the counter file',
    },
  },
});

// Recovery guard: a fresh process must not re-run a known-complete or indeterminate action.
const may = store.mayExecute(key);
if (!may.allowed) {
  store.close();
  process.exit(3);
}

if (mode === 'skip-if-done') {
  // The ledger allowed it (nothing prior). For this mode we only wanted to prove the guard; do not
  // actually perform the side effect.
  store.close();
  process.exit(0);
}

store.append({ ...base, payload: { type: 'side-effect-started', sideEffectId } });

function increment() {
  const current = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) || 0 : 0;
  writeFileSync(counterPath, String(current + 1));
}

function hangForever() {
  writeFileSync(readyPath, 'ready');
  // Keep the event loop alive so the parent can deliver SIGKILL at a known point.
  setInterval(() => {}, 1_000);
}

if (mode === 'complete') {
  increment();
  store.append({
    ...base,
    payload: {
      type: 'side-effect-settled',
      sideEffectId,
      state: 'known-complete',
      resultDigest: null,
    },
  });
  store.close();
  process.exit(0);
} else if (mode === 'crash-after-increment') {
  increment();
  hangForever();
} else if (mode === 'crash-before-increment') {
  hangForever();
} else {
  store.close();
  process.exit(2);
}
