import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  compact,
  computeBudget,
  eventStoreBoundaryStore,
  evaluateCompaction,
  reduceContext,
  stableHash,
  type CompactionResult,
  type CompactionTrigger,
  type PreservedContext,
  type Summarizer,
} from '@qwen-harness/context';
import { authorityForProfile, createHarnessRuntime } from '@qwen-harness/cli';
import { DashScopeProvider } from '@qwen-harness/provider-dashscope';
import type { Actor, Clock, CorrelationId, Item, ItemId, ThreadId } from '@qwen-harness/protocol';
import type { ModelInputItem, ModelProvider, ModelRequest } from '@qwen-harness/provider-core';
import type { ContextManager, ContextPreparation } from '@qwen-harness/runtime';
import { EventStore } from '@qwen-harness/storage';
import { MODEL_ACTOR, SequentialIds } from '@qwen-harness/testkit';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * CX-03 / CX-04 (Live model) — compaction against the real `qwen3.7-max`.
 *
 * The real model, through the REAL composition (`createHarnessRuntime`, real `EventStore`), reads a
 * series of real files in a workspace with a deliberately SMALL context window. Nothing here is a
 * compaction FLAG: the model's own tool output grows the transcript round after round until the
 * budget (measured by the REAL `@qwen-harness/context` primitives) crosses the 85% proactive
 * threshold and forces compaction to fire on real growth.
 *
 * The context manager is assembled from the real `@qwen-harness/context` package exactly as the
 * shipped CLI assembles it in `apps/cli/src/context.ts` (offload → budget → compact → circuit-breaker
 * → fallback). That CLI wrapper (`createContextManager`) is internal to the `cli` package and not on
 * its public entry point, so — as `evals/e2e/long-context.test.ts` already does — the same ~40 lines
 * of glue are reconstructed here over the real primitives; the thing under test (`@qwen-harness/context`)
 * is the genuine article, and the turn that drives it is a real model turn.
 *
 * Asserts (a) compaction actually committed a durable item, driven by real growth; (b) the PROACTIVE
 * path fired and is observable; (c) the post-compaction summary the live model receives preserves the
 * goal and constraints (CX-03); (d) no secret in the durable log.
 *
 * On CX-04's second path: forcing REACTIVE overflow (reduced conversation already over 100% capacity)
 * reliably against a live model is not dependable — offload keeps the reduced transcript bounded, so
 * a live turn crosses the proactive threshold long before it overflows. Reactive-overflow is proven
 * deterministically in `evals/e2e/long-context.test.ts` (which drives BOTH paths in one turn with a
 * scripted provider). This live test asserts the proactive path it can trigger honestly, and reports
 * whether reactive also happened to fire rather than forcing it.
 *
 * Fails CLOSED (skipped) with no key; runs only under `pnpm test:live`, never `pnpm check`.
 */

const hasKey = Boolean(process.env['DASHSCOPE_API_KEY']);

const KEEP_RECENT = 4;
// A small window so ordinary multi-KB file reads cross the 85% proactive threshold as rounds add up.
const WINDOW = 2600;
// High enough that reads stay INLINE and accumulate in the head, so compaction reclaims a real span
// (rather than every large output offloading to a tiny preview and the compaction freeing too little
// to clear the diminishing-returns circuit breaker). Offload's own path is isolated in long-context.
const OFFLOAD_THRESHOLD = 50_000;
const FILE_CHARS = 3_800;
const FILES = ['alpha.txt', 'bravo.txt', 'charlie.txt', 'delta.txt', 'echo.txt', 'foxtrot.txt'];

// The goal carries its constraints inline, exactly as a real prompt would. The summarizer below
// recovers both FROM the transcript — never injected out of band — so "the goal/constraints survived"
// means the real turn state survived.
const GOAL = 'Read each listed file and report the exact total number of lines across all of them.';
const CONSTRAINT = 'read the files strictly one at a time';
const USER_TEXT =
  `${GOAL} Constraints: ${CONSTRAINT}; never guess a count. ` +
  `The files, all in the workspace root, are: ${FILES.join(', ')}.`;

const autoApprove = {
  request: () => Promise.resolve({ kind: 'approved' as const, scope: 'session' as const }),
};

const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

/** Deterministic filler text mentioning the filename. Contains no `sk-`-shaped tokens. */
function fileBody(name: string): string {
  const words = [
    'handler',
    'request',
    'server',
    'payload',
    'budget',
    'context',
    'summary',
    'offload',
    'transcript',
    'pipeline',
    'runtime',
    'session',
  ];
  let out = `Notes for ${name}.\n`;
  let i = 0;
  while (out.length < FILE_CHARS) {
    out += words[i % words.length] + ' ';
    if (i % 12 === 11) out += `\nLine ${i} of ${name}.\n`;
    i += 1;
  }
  return out.slice(0, FILE_CHARS);
}

/**
 * An honest, deterministic summarizer standing in for the model-backed one. Everything it preserves
 * is DERIVED from the transcript: the goal and constraints are parsed out of the first user message,
 * the active files are the paths that actually appear. This mirrors the CLI's `deterministicSummarizer`.
 */
const summarizer: Summarizer = ({ items }) => {
  const firstUser = items.find((i) => i.type === 'message' && i.role === 'user');
  const raw = firstUser && firstUser.type === 'message' ? firstUser.text.trim() : '';
  const [goalPart, constraintPart] = raw.split(/constraints:/i);
  const goal = (goalPart ?? '').trim() || 'continue the prior work';
  const constraints = (constraintPart ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const preserved: PreservedContext = {
    goal,
    constraints,
    plan: [],
    tasks: [],
    activeFiles: extractActiveFiles(items),
    decisions: [],
    errors: [],
    obligations: [],
  };
  return { prose: 'Read the listed files across several rounds.', preserved };
};

const FILE_PATH = /(?:^|[\s"'(`])([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})(?=[\s"'`):,]|$)/g;
function extractActiveFiles(items: readonly ModelInputItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const text =
      item.type === 'message'
        ? item.text
        : item.type === 'function-output'
          ? item.output
          : item.argumentsJson;
    for (const m of text.matchAll(FILE_PATH)) {
      const p = m[1];
      if (p !== undefined && !p.startsWith('.') && p.includes('.')) seen.add(p);
    }
  }
  return [...seen];
}

interface InstrumentedManager extends ContextManager {
  readonly triggers: readonly CompactionTrigger[];
  readonly committed: number;
}

/**
 * The context manager, assembled from the real `@qwen-harness/context` primitives exactly as the
 * shipped CLI assembles it: (1) cheap reduction offloads large tool outputs to the durable blob store
 * and prunes safe middle content; (2) the reduced conversation is budgeted; (3) past the proactive
 * threshold (or over capacity) it compacts head-into-summary, writing the boundary FIRST; a
 * diminishing-returns or failed summary trips the circuit breaker and falls back rather than looping.
 */
function buildManager(opts: {
  store: EventStore;
  contextWindow: number;
  actor: Actor;
  ids: SequentialIds;
}): InstrumentedManager {
  const triggers: CompactionTrigger[] = [];
  let itemSeq = 0;
  let committed = 0;

  return {
    get triggers() {
      return triggers;
    },
    get committed() {
      return committed;
    },

    async prepare(call): Promise<ContextPreparation> {
      const instructionsOverhead = Math.ceil(call.instructions.length / 4);

      const reduced = reduceContext(call.conversation, {
        offloadThresholdChars: OFFLOAD_THRESHOLD,
        preserveRecent: KEEP_RECENT,
        makeRefId: (item) => {
          const digest = `blb_${stableHash(item.output)}`;
          opts.store.putBlob(digest, item.output);
          return digest;
        },
      });

      const budget = computeBudget({
        contextWindow: opts.contextWindow,
        items: reduced.items,
        fixedOverheadTokens: instructionsOverhead,
      });

      const fallback = (): ContextPreparation => ({
        items: reduced.items,
        utilization: budget.utilization,
        compacted: false,
        trigger: null,
      });

      if (!(budget.overThreshold || budget.overCapacity)) return fallback();

      const splitAt = Math.max(0, reduced.items.length - KEEP_RECENT);
      const head = reduced.items.slice(0, splitAt);
      const tail = reduced.items.slice(splitAt);
      if (head.length === 0) return fallback();

      const trigger: CompactionTrigger = budget.overCapacity ? 'reactive-overflow' : 'proactive';

      try {
        const boundaryStore = eventStoreBoundaryStore({
          store: opts.store,
          threadId: call.threadId,
          turnId: call.turnId,
          actor: opts.actor,
          correlationId: call.correlationId,
          permissionProfile: call.permissionProfile,
          ids: opts.ids,
          clock,
          nextItemSeq: () => itemSeq++,
        });

        const result = await compact({ items: head, summarizer, boundaryStore, trigger });
        if (evaluateCompaction(result).kind === 'no-further-reduction') return fallback();

        recordCompactionItem(opts, call, result, itemSeq++);
        committed += 1;
        triggers.push(result.trigger);

        const summaryItem: ModelInputItem = { type: 'message', role: 'user', text: result.summary };
        return {
          items: [summaryItem, ...tail],
          utilization: budget.utilization,
          compacted: true,
          trigger: result.trigger === 'manual' ? null : result.trigger,
        };
      } catch {
        return fallback();
      }
    },
  };
}

function recordCompactionItem(
  opts: { store: EventStore; actor: Actor; ids: SequentialIds },
  call: {
    threadId: ThreadId;
    turnId: string;
    correlationId: CorrelationId;
    permissionProfile: string;
  },
  result: CompactionResult,
  seq: number,
): void {
  const id = opts.ids.next('itm') as ItemId;
  const item = {
    id,
    turnId: call.turnId,
    threadId: call.threadId,
    seq,
    createdAt: clock.now(),
    type: 'compaction',
    trigger: result.trigger,
    transcriptBoundaryRef: result.boundaryRef,
    summary: result.summary,
    tokensBefore: result.tokensBefore,
    tokensAfter: Math.max(0, result.tokensAfter),
  } as unknown as Extract<Item, { type: 'compaction' }>;
  opts.store.append({
    threadId: call.threadId,
    turnId: call.turnId as never,
    itemId: id,
    actor: opts.actor,
    correlationId: call.correlationId,
    permissionProfile: call.permissionProfile as never,
    payload: { type: 'item-appended', item },
  });
}

/** Wraps the real provider to record the input array of every request, so the test can inspect what
 * the model actually received — the real model still runs; only its inputs are observed. */
function recordingProvider(
  inner: ModelProvider,
): ModelProvider & { requests: readonly ModelInputItem[][] } {
  const requests: ModelInputItem[][] = [];
  return {
    requests,
    capabilities: inner.capabilities,
    stream: (request: ModelRequest) => {
      requests.push([...request.input]);
      return inner.stream(request);
    },
  };
}

describe.skipIf(!hasKey)(
  'live compaction (qwen3.7-max, real growth forces offload+compaction)',
  () => {
    let workspace: string;
    let store: EventStore;
    let ids: SequentialIds;

    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), 'qh-compact-live-'));
      execSync('git init -q', { cwd: workspace });
      for (const name of FILES) writeFileSync(join(workspace, name), fileBody(name));
      ids = new SequentialIds();
      store = new EventStore({ path: ':memory:', clock, ids });
    });

    afterEach(() => {
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    });

    it('grows a real transcript, compacts, and preserves goal+constraints in the summary', async () => {
      const provider = recordingProvider(new DashScopeProvider());
      const context = buildManager({ store, contextWindow: WINDOW, actor: MODEL_ACTOR, ids });

      const threadId = ids.next('thr') as ThreadId;
      const correlationId = ids.next('cor') as CorrelationId;
      store.append({
        threadId,
        correlationId,
        permissionProfile: 'ask',
        actor: { kind: 'user', id: 'act_user01' as never },
        payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
      });

      const runtime = createHarnessRuntime({
        workspaceRoot: workspace,
        authority: authorityForProfile('ask'),
        model: 'qwen3.7-max',
        instructions:
          'You are a terse assistant working in a sandboxed workspace. Follow the user’s ' +
          'constraints exactly. Read each file with the read_file tool, one file per step, before ' +
          'you answer.',
        homeDir: workspace,
        clock,
        ids,
        store,
        client: new ToolWorkerClient(),
        approvals: autoApprove,
        provider,
        context,
      });

      const result = await runtime.runTurn({ threadId, correlationId, userText: USER_TEXT });

      expect(result.state, `terminated ${result.state}: ${result.finalText}`).toBe('completed');

      // (a) Compaction actually COMMITTED at least one durable item, driven by real transcript growth.
      const compactions = store
        .readThread(threadId)
        .map((e) => e.payload)
        .filter((p) => p.type === 'item-appended' && p.item.type === 'compaction')
        .map((p) => (p.type === 'item-appended' ? p.item : null))
        .filter((i): i is Extract<Item, { type: 'compaction' }> => i?.type === 'compaction');
      expect(
        compactions.length,
        `no compaction committed; manager triggers=${JSON.stringify(context.triggers)}`,
      ).toBeGreaterThanOrEqual(1);

      // (b) The PROACTIVE path fired and is observable in the manager and in the durable item.
      expect(context.triggers).toContain('proactive');
      expect(compactions.some((c) => c.trigger === 'proactive')).toBe(true);

      // (c) The post-compaction summary the live model RECEIVED preserves the goal and constraints.
      const flat = provider.requests.map((input) =>
        input
          .map((i) =>
            i.type === 'message' ? i.text : i.type === 'function-output' ? i.output : '',
          )
          .join('\n'),
      );
      const withSummary = flat.filter((t) => t.includes('# Compaction summary'));
      expect(withSummary.length, 'the model never received a compaction summary').toBeGreaterThan(
        0,
      );
      const summaryText = withSummary[withSummary.length - 1]!;
      expect(summaryText).toContain(GOAL); // goal survived
      expect(summaryText).toContain(CONSTRAINT); // constraint survived

      // And the durable compaction item carries the same preserved goal/constraint (auditable record).
      const durableSummary = compactions[compactions.length - 1]!.summary;
      expect(durableSummary).toContain(GOAL);
      expect(durableSummary).toContain(CONSTRAINT);

      // (d) No secret anywhere in the durable log.
      const dump = JSON.stringify(store.readThread(threadId));
      expect(dump).not.toMatch(/sk-[A-Za-z0-9]{16,}/);

      // Diagnostics: which paths fired, for the honest report on CX-04.
      console.log(
        `[live-compaction] committed=${context.committed} triggers=${JSON.stringify(context.triggers)} ` +
          `provider-rounds=${provider.requests.length}`,
      );
    }, 300_000);
  },
);
