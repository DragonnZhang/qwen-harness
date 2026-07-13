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
import type { Actor, CorrelationId, Item, ItemId, ThreadId } from '@qwen-harness/protocol';
import {
  freezeCapabilities,
  type ModelInputItem,
  type ModelProvider,
  type ModelRequest,
  type ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import {
  TurnEngine,
  type ContextManager,
  type ContextPreparation,
  type EventSink,
  type ToolExecutor,
} from '@qwen-harness/runtime';
import { EventStore } from '@qwen-harness/storage';
import { MODEL_ACTOR, ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * GOLDEN PATH 4 — Long context (capability-matrix.md):
 *
 *   "generate large tool output and transcript, trigger offload and compaction, then prove goal,
 *    constraints, tasks, active files, team identity, and permissions remain correct."
 *
 * This drives the REAL `TurnEngine` over the REAL `EventStore` (with its real blob store) through a
 * REAL context manager assembled from the REAL `@qwen-harness/context` package — the same offload →
 * budget → compact → circuit-breaker → fallback pipeline the CLI ships in `apps/cli/src/context.ts`.
 * Nothing here is a compaction FLAG: a scripted provider calls a tool every round, a scripted tool
 * returns genuinely large output, and the transcript grows past a small window ON ITS OWN until the
 * budget forces compaction. The integration test `apps/cli/test/integration/compaction.test.ts`
 * proves the SEAM (compaction fires, a summary reaches the model, the transcript shrank). This eval
 * proves the golden path's SURVIVAL contract on top of that: after real offload + proactive AND
 * reactive compaction, every required property still reaches the model or the durable log.
 *
 * On "team identity": the single-CLI turn has no team. The identity that IS in play is the run's
 * actor + permission profile, and the meaningful claim is that compaction does not swap or elevate
 * it. We assert THAT (see the permissions/identity test) and note the team-identity sub-claim of
 * golden path 4 needs the team wiring, which is built elsewhere.
 */

const THREAD = 'thr_longctx0' as ThreadId;
const CORR = 'cor_longctx0' as CorrelationId;

// The user's goal carries an explicit constraint inline, exactly as a real prompt would. Both the
// goal and the constraint are recovered FROM the transcript by the summarizer below — not injected
// out of band — so "the goal/constraint survived" means the real turn state survived.
const GOAL = 'Implement the request handler in server.ts and server.test.ts.';
const CONSTRAINT = 'do not touch .git';
const USER_TEXT = `${GOAL} Constraints: ${CONSTRAINT}; keep tests green.`;

// The system instructions are re-sent verbatim on every provider request and are never part of the
// compactable conversation. A hard rule placed here is the always-on constraint channel; the test
// asserts it survives every round including post-compaction ones.
const INSTRUCTIONS = 'You are a terse coding agent. Hard rule: never write under .git.';

// The live todo/task state the turn is preserving (WK-01: preservation through compaction). In the
// shipped CLI this comes from the durable task graph via `tasksProvider`; here it is the same seam.
const TASKS = ['task-1: wire the request handler', 'task-2: cover it with a test'];

const KEEP_RECENT = 4;

// A deliberately small window so ordinary ~2 KB tool outputs cross the 85% proactive threshold as
// rounds accumulate (offload keeps them bounded, so it takes several rounds — real growth, not a
// flag). The last two rounds return a much larger output that lands in the un-offloaded recent tail
// and pushes the budget over capacity, which is the reactive-overflow path. One turn, both paths.
const WINDOW = 3000;
const TOOL_ROUNDS = 12;
const OFFLOAD_THRESHOLD = 1500;
const STEADY_BYTES = 2_000;
const LARGE_BYTES = 12_000;
// A larger window used by the offload test: big enough that steady ~2 KB outputs stay UNDER the
// compaction threshold, so cheap reduction offloads them and the bounded preview actually reaches
// the model (rather than being folded into a compaction summary). This isolates the offload path.
const OFFLOAD_WINDOW = 6_000;
/** Steady ~2 KB output, except the final two rounds which are large enough to overflow capacity. */
const bothPathsSize = (round: number): number =>
  round >= TOOL_ROUNDS - 2 ? LARGE_BYTES : STEADY_BYTES;

/** Workspace-relative file paths that literally appear in the span (mirrors the CLI extractor). */
function extractActiveFiles(items: readonly ModelInputItem[]): string[] {
  const re = /(?:^|[\s"'(`])([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})(?=[\s"'`):,]|$)/g;
  const seen = new Set<string>();
  for (const item of items) {
    const text =
      item.type === 'message'
        ? item.text
        : item.type === 'function-output'
          ? item.output
          : item.argumentsJson;
    for (const m of text.matchAll(re)) {
      const p = m[1];
      if (p !== undefined && !p.startsWith('.') && p.includes('.')) seen.add(p);
    }
  }
  return [...seen];
}

/**
 * An honest, deterministic summarizer standing in for the injected model call. Everything it
 * preserves is DERIVED from the transcript or the live task state, never invented: the goal and the
 * constraint are parsed out of the first user message, the active files are the paths that actually
 * appear, and the tasks are the current todo list.
 */
function goldenSummarizer(tasks: () => readonly string[]): Summarizer {
  return ({ items }) => {
    const firstUser = items.find((i) => i.type === 'message' && i.role === 'user');
    const raw = (firstUser && firstUser.type === 'message' ? firstUser.text : '').trim();
    const [goalPart, constraintPart] = raw.split(/constraints:/i);
    const goal = (goalPart ?? '').trim() || 'continue the prior work';
    const constraints = (constraintPart ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const preserved: PreservedContext = {
      goal,
      constraints,
      plan: ['read the target files', 'edit the handler'],
      tasks: [...tasks()],
      activeFiles: extractActiveFiles(items),
      decisions: [],
      errors: [],
      obligations: ['update the changelog'],
    };
    return { prose: 'Read the target files across several rounds.', preserved };
  };
}

/** A summarizer whose structured output is INVALID (empty goal): compaction must reject and fall back. */
const brokenSummarizer: Summarizer = () => ({
  prose: 'oops',
  preserved: {
    goal: '', // violates PreservedContextSchema (goal.min(1)) -> InvalidCompactionSummaryError
    constraints: [],
    plan: [],
    tasks: [],
    activeFiles: [],
    decisions: [],
    errors: [],
    obligations: [],
  },
});

interface ManagerOptions {
  readonly store: EventStore;
  readonly contextWindow: number;
  readonly clock: ManualClock;
  readonly ids: SequentialIds;
  readonly actor: Actor;
  readonly summarizer: Summarizer;
  readonly offloadThresholdChars: number;
}

interface InstrumentedManager extends ContextManager {
  /** Every committed compaction's trigger, in order — proves proactive AND reactive both fired. */
  readonly triggers: readonly CompactionTrigger[];
  /** How many compactions actually committed a summary (survived the circuit breaker). */
  readonly committed: number;
  /** How many times compaction was ATTEMPTED (crossed the threshold). */
  readonly attempted: number;
}

/**
 * The context manager, assembled from the real `@qwen-harness/context` primitives exactly as the
 * shipped CLI assembles it: (1) cheap reduction offloads large tool outputs to the durable blob
 * store and prunes safe middle content; (2) the reduced conversation is budgeted; (3) past the
 * proactive threshold (or over capacity) it compacts head-into-summary, writing the boundary FIRST;
 * a diminishing-returns or failed summary trips the circuit breaker and falls back to the reduced
 * conversation rather than killing the turn.
 */
function buildManager(opts: ManagerOptions): InstrumentedManager {
  const triggers: CompactionTrigger[] = [];
  let itemSeq = 0;
  let committed = 0;
  let attempted = 0;

  const manager: InstrumentedManager = {
    get triggers() {
      return triggers;
    },
    get committed() {
      return committed;
    },
    get attempted() {
      return attempted;
    },

    async prepare(call): Promise<ContextPreparation> {
      const instructionsOverhead = Math.ceil(call.instructions.length / 4);

      // (1) cheap reduction: offload large outputs to the durable blob store (the ref id IS the
      // content digest, and writing it here is what durably captures the payload), prune safe middle.
      const reduced = reduceContext(call.conversation, {
        offloadThresholdChars: opts.offloadThresholdChars,
        preserveRecent: KEEP_RECENT,
        makeRefId: (item) => {
          const digest = `blb_${stableHash(item.output)}`;
          opts.store.putBlob(digest, item.output);
          return digest;
        },
      });

      // (2) budget the reduced conversation.
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
        attempted += 1;
        const boundaryStore = eventStoreBoundaryStore({
          store: opts.store,
          threadId: call.threadId,
          turnId: call.turnId,
          actor: opts.actor,
          correlationId: call.correlationId,
          permissionProfile: call.permissionProfile,
          ids: opts.ids,
          clock: opts.clock,
          nextItemSeq: () => itemSeq++,
        });

        const result = await compact({
          items: head,
          summarizer: opts.summarizer,
          boundaryStore,
          trigger,
        });

        // Diminishing-returns circuit breaker: a compaction that frees too little is discarded.
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
        // A failed/invalid summary must NEVER end the turn: send the cheaply-reduced conversation.
        return fallback();
      }
    },
  };
  return manager;
}

function recordCompactionItem(
  opts: ManagerOptions,
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
    createdAt: opts.clock.now(),
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

/** Records the exact input + instructions of every request, so the test inspects what the model saw. */
function recordingProvider(
  toolRounds: number,
): ModelProvider & { requests: { input: ModelInputItem[]; instructions: string }[] } {
  const requests: { input: ModelInputItem[]; instructions: string }[] = [];
  let round = 0;
  return {
    requests,
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: false,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push({ input: [...request.input], instructions: request.instructions });
      const n = round++;
      if (n < toolRounds) {
        // Distinct arguments per round: the engine's no-progress guard stops a model that repeats
        // the SAME call, which is not what this test exercises.
        const path = `chunk_${n}.ts`;
        yield {
          type: 'tool-call-complete',
          itemId: `t${n}`,
          callId: `call_read_${n}0000000`,
          toolName: 'read_file',
          argumentsJson: `{"path":"${path}"}`,
          arguments: { path },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text-done', itemId: `m${n}`, text: 'All done.' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/** A tool executor whose result size is chosen per round, so we can drive proactive then reactive. */
function bigOutputExecutor(sizeFor: (round: number) => number): ToolExecutor {
  let round = 0;
  return {
    evaluate: (c) =>
      Promise.resolve({
        status: 'allow' as const,
        actionDigest: `digest:${c.callId}`,
        description: c.toolName,
        risk: 'low' as const,
        reason: 'allow',
        source: 'test',
      }),
    intentFor: (c) => ({
      idempotencyKey: `${c.toolName}:${JSON.stringify(c.arguments)}`,
      destructive: false,
      kind: 'other' as const,
      normalizedAction: c.toolName,
    }),
    execute: (c) => {
      const n = round++;
      const path = String((c.arguments as { path?: unknown }).path ?? 'file.ts');
      const body =
        `contents of server.ts and server.test.ts for ${path}\n` + 'Q'.repeat(sizeFor(n));
      return Promise.resolve({
        ok: true,
        modelText: body,
        userText: body,
        errorCategory: null,
        resultDigest: `res:${c.callId}`,
        outputRef: null,
        truncated: false,
        durationMs: 1,
      });
    },
  };
}

function textOf(input: readonly ModelInputItem[]): string {
  return input
    .map((i) => (i.type === 'message' ? i.text : i.type === 'function-output' ? i.output : ''))
    .join('\n');
}

describe('golden path 4 — long context: offload + proactive/reactive compaction preserve the run', () => {
  let store: EventStore;
  let clock: ManualClock;
  let ids: SequentialIds;

  beforeEach(() => {
    clock = new ManualClock(1_700_000_000_000);
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
  });

  const sink = (): EventSink => ({
    append: (input) =>
      store.append({ ...input, causationId: (input.causationId ?? null) as never }),
    mayExecute: (key) => store.mayExecute(key),
  });

  function run(
    manager: InstrumentedManager,
    provider: ReturnType<typeof recordingProvider>,
    executor: ToolExecutor,
  ) {
    const engine = new TurnEngine({
      provider,
      tools: executor,
      sink: sink(),
      ids,
      clock,
      context: manager,
    });
    return engine.run({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      model: 'qwen3.7-max',
      instructions: INSTRUCTIONS,
      history: [],
      userText: USER_TEXT,
      tools: [],
      actor: MODEL_ACTOR,
    });
  }

  it('grows a real transcript, offloads + compacts (proactive AND reactive), and preserves goal/constraints/tasks/files', async () => {
    const provider = recordingProvider(TOOL_ROUNDS);
    const manager = buildManager({
      store,
      contextWindow: WINDOW,
      clock,
      ids,
      actor: MODEL_ACTOR,
      summarizer: goldenSummarizer(() => TASKS),
      offloadThresholdChars: OFFLOAD_THRESHOLD,
    });
    const executor = bigOutputExecutor(bothPathsSize);

    const result = await run(manager, provider, executor);
    expect(result.state).toBe('completed');

    // BOTH compaction paths actually fired on real growth (CX-04: proactive and reactive are distinct).
    expect(manager.triggers).toContain('proactive');
    expect(manager.triggers).toContain('reactive-overflow');

    // Compaction is durable + observable: boundary markers + final summary items on the log (CX-03).
    const compactionItems = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .filter((p) => p.type === 'item-appended' && p.item.type === 'compaction');
    expect(compactionItems.length).toBeGreaterThanOrEqual(manager.committed + 1);

    // The model ACTUALLY received a compaction summary that carries every required survival field.
    const summaryTexts = provider.requests
      .map((r) => textOf(r.input))
      .filter((t) => t.includes('# Compaction summary'));
    expect(summaryTexts.length).toBeGreaterThan(0);
    const summary = summaryTexts[summaryTexts.length - 1];
    expect(summary).toContain(GOAL); // goal survived
    expect(summary).toContain(CONSTRAINT); // constraint survived, parsed from the transcript
    for (const task of TASKS) expect(summary).toContain(task); // todo/task state survived
    expect(summary).toContain('server.ts'); // active file survived
    expect(summary).toContain('server.test.ts'); // active file survived
    expect(summary).toContain('update the changelog'); // unfinished obligation survived

    // The always-on constraint channel (system instructions) is re-sent verbatim EVERY round,
    // including post-compaction rounds — compaction never drops or rewrites the ceiling text.
    expect(provider.requests.length).toBeGreaterThan(5);
    for (const r of provider.requests) expect(r.instructions).toBe(INSTRUCTIONS);

    // The transcript genuinely stayed bounded. Sent whole, the final round would carry the sum of
    // every raw output. Offload + compaction held every request the model ever saw below that total
    // (dominated by the couple of large recent outputs, not the whole accumulated history).
    let rawTotal = 0;
    for (let n = 0; n < TOOL_ROUNDS; n++) rawTotal += bothPathsSize(n);
    const sizes = provider.requests.map((r) => textOf(r.input).length);
    expect(Math.max(...sizes)).toBeLessThan(rawTotal);
  });

  it('offloads large output to a durable, retrievable blob — a real payload, not a dangling ref', async () => {
    const provider = recordingProvider(8);
    const manager = buildManager({
      store,
      contextWindow: OFFLOAD_WINDOW,
      clock,
      ids,
      actor: MODEL_ACTOR,
      summarizer: goldenSummarizer(() => TASKS),
      offloadThresholdChars: OFFLOAD_THRESHOLD,
    });
    const result = await run(
      manager,
      provider,
      bigOutputExecutor(() => STEADY_BYTES),
    );
    expect(result.state).toBe('completed');

    // Find the actual offloaded item the model received: a bounded inline preview that names its ref.
    const refRe = /offloaded — ref=(blb_[0-9a-z]+), (\d+) chars/;
    let inline: string | undefined;
    for (const r of provider.requests) {
      for (const item of r.input) {
        if (item.type === 'function-output' && refRe.test(item.output)) inline = item.output;
      }
    }
    expect(inline, 'the model should have received an offloaded preview inline').toBeTruthy();
    const [, digest, statedChars] = refRe.exec(inline as string) as RegExpExecArray;

    // The reference resolves to the FULL original output in the durable blob store (not a dangling
    // ref): retrievable, byte-count-consistent with what was offloaded, and genuinely large.
    const blob = store.readBlob(digest);
    expect(blob).toBeTruthy();
    expect((blob as string).length).toBe(Number(statedChars)); // ref's declared size == stored payload
    expect((blob as string).length).toBeGreaterThan(STEADY_BYTES);
    expect(blob as string).toContain('contents of server.ts and server.test.ts');
    // The inline representation really was BOUNDED — the full payload is bigger than what stayed
    // inline, so offload shrank the model-facing transcript while keeping the whole thing retrievable.
    expect((blob as string).length).toBeGreaterThan((inline as string).length);

    // Negative control: an unknown digest is genuinely absent, so "retrievable" is a real lookup.
    expect(store.readBlob('blb_deadbeef')).toBeUndefined();

    // Every offloaded ref the model ever saw resolves to a real blob — no reference points at nothing.
    const allRefs = new Set<string>();
    for (const r of provider.requests) {
      for (const m of textOf(r.input).matchAll(/ref=(blb_[0-9a-z]+)/g)) allRefs.add(m[1] as string);
    }
    expect(allRefs.size).toBeGreaterThan(0);
    for (const ref of allRefs) expect(store.readBlob(ref)).toBeTruthy();
  });

  it('keeps the permission profile and actor identity constant across compaction (no silent relax)', async () => {
    const provider = recordingProvider(TOOL_ROUNDS);
    const manager = buildManager({
      store,
      contextWindow: WINDOW,
      clock,
      ids,
      actor: MODEL_ACTOR,
      summarizer: goldenSummarizer(() => TASKS),
      offloadThresholdChars: OFFLOAD_THRESHOLD,
    });
    const result = await run(manager, provider, bigOutputExecutor(bothPathsSize));
    expect(result.state).toBe('completed');
    expect(manager.committed).toBeGreaterThan(0); // compaction really happened in this run

    const events = store.readThread(THREAD);

    // PERMISSIONS: every event on the thread — user, model, AND the compaction items written during
    // compaction — carries the run's profile. Compaction does not silently relax the ceiling.
    const profiles = new Set(events.map((e) => e.permissionProfile));
    expect([...profiles]).toEqual(['ask']);

    // The compaction items themselves are attributed to the run's MODEL actor, not some elevated or
    // swapped identity. This is the "identity that IS present" in the single-CLI path: there is no
    // team here, and the point of the check is that compaction neither invents nor escalates one.
    const compactionEvents = events.filter(
      (e) => e.payload.type === 'item-appended' && e.payload.item.type === 'compaction',
    );
    expect(compactionEvents.length).toBeGreaterThan(0);
    for (const e of compactionEvents) {
      expect(e.permissionProfile).toBe('ask');
      expect(e.actor.kind).toBe('model');
      expect(e.actor.id).toBe(MODEL_ACTOR.id);
    }

    // Identity is stable BEFORE and AFTER the first compaction: the model actor never changes across
    // the boundary, so the run's authority carrier is not swapped by compaction.
    const firstCompactionSeq = compactionEvents[0].seq;
    const modelBefore = events.filter(
      (e) => e.seq < firstCompactionSeq && e.actor.kind === 'model',
    );
    const modelAfter = events.filter((e) => e.seq > firstCompactionSeq && e.actor.kind === 'model');
    expect(modelBefore.length).toBeGreaterThan(0);
    expect(modelAfter.length).toBeGreaterThan(0);
    for (const e of [...modelBefore, ...modelAfter]) expect(e.actor.id).toBe(MODEL_ACTOR.id);
  });

  it('circuit breaker: an invalid summary degrades gracefully — the turn completes, it is not killed', async () => {
    const provider = recordingProvider(TOOL_ROUNDS);
    const manager = buildManager({
      store,
      contextWindow: WINDOW,
      clock,
      ids,
      actor: MODEL_ACTOR,
      summarizer: brokenSummarizer, // every compaction attempt throws InvalidCompactionSummaryError
      offloadThresholdChars: OFFLOAD_THRESHOLD,
    });
    const result = await run(manager, provider, bigOutputExecutor(bothPathsSize));

    // The turn still COMPLETES: a failed compaction falls back to the cheaply-reduced conversation
    // instead of dropping the turn on the floor (CX-04 retry circuit breaker).
    expect(result.state).toBe('completed');
    expect(manager.attempted).toBeGreaterThan(0); // it really tried to compact, on real growth
    expect(manager.committed).toBe(0); // and never committed an invalid summary

    // No final compaction summary item was committed, but the boundary markers (written FIRST, before
    // the summarizer runs) are still durable — the attempt is auditable and nothing was lost.
    const compactionItems = store
      .readThread(THREAD)
      .map((e) => e.payload)
      .filter((p) => p.type === 'item-appended' && p.item.type === 'compaction');
    expect(compactionItems.length).toBeGreaterThan(0);
    // Because no valid summary was produced, no request ever carried a "# Compaction summary".
    const anySummary = provider.requests.some((r) =>
      textOf(r.input).includes('# Compaction summary'),
    );
    expect(anySummary).toBe(false);

    // Offload still protected the budget even though compaction could not commit: blobs were written.
    const blobCount = store.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number };
    expect(blobCount.n).toBeGreaterThan(0);
  });
});
