/**
 * The LIVE turn controller — the same {@link LiveController} the scripted demo implements, but
 * backed by the REAL composition: the real DashScope provider, the real sandboxed tool pipeline,
 * the real policy ceiling, and the durable event store, via `createHarnessRuntime`.
 *
 * This is what makes `qwen-harness-tui run "<prompt>"` an actual interactive session instead of a
 * demo. Two live bridges connect the engine to the Ink UI:
 *
 *   1. STREAMING TEXT — the injected provider is a thin tee over `defaultProvider`: every
 *      `text-delta`/`text-done` event is forwarded to the transcript's live row as it arrives,
 *      then passed through unchanged to the engine's normalizer. The user sees tokens as the model
 *      emits them, which is the whole point of a streaming TUI.
 *   2. DURABLE ITEMS — `onEvent` mirrors every persisted `item-appended` (tool calls, tool results,
 *      reasoning summaries, usage) into the source, EXCEPT `assistant-message`, which the streaming
 *      tee already renders. This is exactly the split the scripted `durableSink` uses.
 *
 * The approval gate and the abort signal are the same UI bridges the scripted controller uses, so
 * `live.tsx` renders a live runtime and a scripted one identically.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createHarnessRuntime,
  defaultProvider,
  loadRunAuthority,
  reconstructHistory,
  type HarnessRuntime,
  type RunAuthority,
} from '@qwen-harness/cli';
import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import {
  ItemSchema,
  sanitize,
  type CorrelationId,
  type HarnessEvent,
  type PermissionProfile,
  type ThreadId,
  type TurnId,
} from '@qwen-harness/protocol';
import type {
  ApprovalDecision as EngineApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
} from '@qwen-harness/runtime';
import { EnvCredentialSource } from '@qwen-harness/provider-dashscope';
import { EventStore } from '@qwen-harness/storage';

import type { ApprovalPrompt, StatusModel } from './types.ts';
import { nextProfile, type LiveController, type LiveView } from './scripted-turn.ts';
import { emitterSource, type MutableSource } from './source.ts';

const MODEL = 'qwen3.7-max';
const INSTRUCTIONS =
  'You are a terse coding assistant working in a sandboxed workspace. Use the available tools to ' +
  'inspect and edit files and run commands. Be concise.';

let idCounter = 0;
/**
 * Monotonic, collision-resistant ids for a single interactive process. This mirrors the CLI's
 * headless id source; the daemon uses a durable high-water source instead.
 */
const ids = {
  next(prefix: string): string {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}`;
  },
};

/**
 * Wrap a provider so every stream event is observed before it is passed through. The observer sees
 * exactly what the engine's normalizer sees, so a streamed row can never diverge from the durable
 * assistant message.
 */
function teeProvider(
  base: ModelProvider,
  onEvent: (event: ProviderStreamEvent) => void,
): ModelProvider {
  return {
    capabilities: base.capabilities,
    async *stream(request) {
      for await (const event of base.stream(request)) {
        onEvent(event);
        yield event;
      }
    },
  };
}

export interface LiveTurnOptions {
  readonly mode: StatusModel['mode'];
  readonly cwd: string;
  /**
   * Resume an EXISTING durable thread instead of starting a fresh one (UI-10). When set, no
   * `thread-created` is appended; the thread's persisted transcript is re-projected into the source
   * so the picker's selection re-renders exactly what prior turns produced, and the next submit
   * continues the SAME conversation via `reconstructHistory`.
   */
  readonly resume?: { readonly threadId: ThreadId } | undefined;
  /**
   * Override the managed-policy path (defaults to the OS-wide managed file). TEST-ONLY: it lets a
   * unit test point the ceiling at a temp `managed.json`, so a runtime mode switch can be proven to
   * clamp against a real administrator policy without touching `/etc`.
   */
  readonly managedPath?: string | undefined;
}

/**
 * Re-project a thread's DURABLE transcript into the live source for display on resume (UI-10).
 *
 * This reads the event log the same way {@link reconstructHistory} does, but it produces UI ITEMS
 * (what the transcript renders) rather than model-input history. User text lives on `turn-started`,
 * not as an item, so it is minted into a fresh `user-message` item; every persisted `item-appended`
 * (assistant text, tool calls, tool results, usage, …) is replayed verbatim. Each item still crosses
 * `tui-kit`'s `SafeText` boundary when the transcript is built, exactly as a live item does.
 */
function projectDurableTranscript(
  store: EventStore,
  threadId: ThreadId,
  source: MutableSource,
  ids: { next(prefix: string): string },
): void {
  for (const event of store.readThread(threadId)) {
    const p = event.payload;
    if (p.type === 'turn-started') {
      source.push(
        ItemSchema.parse({
          id: ids.next('itm'),
          turnId: event.turnId ?? (threadId.replace('thr', 'trn') as TurnId),
          threadId,
          seq: event.seq,
          createdAt: event.timestamp,
          type: 'user-message',
          text: p.userText,
        }),
      );
    } else if (p.type === 'item-appended') {
      source.push(p.item);
    }
  }
}

/**
 * Build a live controller over the real runtime. State is created lazily on the first submit so the
 * UI mounts instantly (and a missing credential surfaces as a failed turn in the transcript, not a
 * crash at startup).
 */
export function createLiveTurn(opts: LiveTurnOptions): LiveController {
  const { mode, cwd } = opts;
  const source = emitterSource();

  const stateDir = join(cwd, '.qwen-harness');
  mkdirSync(stateDir, { recursive: true });
  const store = new EventStore({
    path: join(stateDir, 'sessions.sqlite'),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    ids,
    // The redactor needs the credential VALUE to scrub it from persisted content. We do NOT read
    // it from the environment here — `EnvCredentialSource` is the one boundary permitted to read it
    // (architecture rule 6); reading `process.env` directly would evade that invariant.
    secrets: [new EnvCredentialSource().read() ?? undefined],
  });

  const managedPath = opts.managedPath;
  // Re-derive the authority for a REQUESTED profile. `loadRunAuthority` applies precedence and clamps
  // to the managed ceiling, so `authority.profile` is the EFFECTIVE (possibly downgraded) profile —
  // a requested `yolo` under `maxProfile: plan` comes back as `plan`. This is the one place the mode
  // is turned into authority; nothing downstream re-derives it.
  const loadAuthorityFor = (profile: PermissionProfile): RunAuthority => {
    try {
      return loadRunAuthority({
        projectRoot: cwd,
        homeDir: homedir(),
        env: process.env,
        cli: { permissionProfile: profile },
        ...(managedPath !== undefined ? { managedPath } : {}),
      });
    } catch {
      // A broken config must not brick the UI; fall back to a bare profile authority.
      return loadRunAuthority({
        projectRoot: cwd,
        homeDir: homedir(),
        env: {},
        cli: {},
        ...(managedPath !== undefined ? { managedPath } : {}),
      });
    }
  };

  // The REQUESTED profile is what the user cycles through; `authority.profile` is what the ceiling
  // allows. They diverge exactly when a managed policy clamps the request.
  let requestedProfile: PermissionProfile = mode;
  let authority: RunAuthority = loadAuthorityFor(requestedProfile);

  const baseStatus = (activity: StatusModel['activity']): StatusModel => ({
    cwd: sanitize(cwd, { origin: 'user', multiline: false, maxLength: 80 }).text,
    model: sanitize(authority.config.model.value, { origin: 'user', multiline: false }).text,
    mode: authority.profile,
    activity,
    contextTokens: null,
  });

  let view: LiveView = { status: baseStatus('idle'), approval: null };
  const listeners = new Set<() => void>();
  const setView = (next: LiveView): void => {
    view = next;
    for (const listener of listeners) listener();
  };

  const resumeThreadId = opts.resume?.threadId ?? null;
  const threadId = resumeThreadId ?? (ids.next('thr') as ThreadId);
  const turnIdSeed = threadId.replace('thr', 'trn') as TurnId;
  if (resumeThreadId === null) {
    store.append({
      threadId,
      correlationId: ids.next('cor') as CorrelationId,
      permissionProfile: authority.profile,
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd, canonicalRepo: cwd, name: null },
    });
  } else {
    projectDurableTranscript(store, threadId, source, ids);
  }

  let running = false;
  let abort: AbortController | null = null;
  let resolveApproval: ((decision: EngineApprovalDecision) => void) | null = null;
  let userSeq = 0;

  const approvals: ApprovalGate = {
    request(request: ApprovalRequest): Promise<EngineApprovalDecision> {
      const prompt: ApprovalPrompt = {
        actor: sanitize('model', { origin: 'user', multiline: false }).text,
        action: sanitize(request.description, { origin: 'tool', multiline: false, maxLength: 200 })
          .text,
        risk: request.risk,
        isolation: sanitize(authority.isolation, { origin: 'user', multiline: false }).text,
      };
      setView({ status: view.status, approval: prompt });
      return new Promise<EngineApprovalDecision>((resolve) => {
        resolveApproval = resolve;
      });
    },
  };

  // Durable items → transcript, except assistant text (the streaming tee owns that row).
  const onEvent = (event: HarnessEvent): void => {
    if (event.payload.type !== 'item-appended') return;
    const item = event.payload.item;
    if (item.type === 'assistant-message') return;
    source.push(item);
  };

  // Streaming assistant text → the live row, as tokens arrive.
  let streamText = '';
  let streamItemId = '';
  const onStream = (event: ProviderStreamEvent): void => {
    if (event.type === 'text-delta') {
      if (streamItemId === '') streamItemId = ids.next('itm');
      streamText += event.delta;
    } else if (event.type === 'text-done') {
      if (streamItemId === '') streamItemId = ids.next('itm');
      streamText = event.text;
    } else {
      return;
    }
    const item = ItemSchema.parse({
      id: streamItemId,
      turnId: turnIdSeed,
      threadId,
      seq: 0,
      createdAt: Date.now(),
      type: 'assistant-message',
      text: streamText,
      complete: event.type === 'text-done',
    });
    source.push(item);
  };

  // Built from the CURRENT `authority`. Cycling the mode reassigns `authority` and rebuilds this so
  // the next turn runs under the re-derived (ceiling-clamped) policy and provider.
  const buildRuntime = (): HarnessRuntime =>
    createHarnessRuntime({
      workspaceRoot: cwd,
      authority,
      model: authority.config.model.value || MODEL,
      instructions: INSTRUCTIONS,
      homeDir: homedir(),
      clock: { now: () => Date.now() },
      ids,
      store,
      provider: teeProvider(defaultProvider(authority), onStream),
      approvals,
      onEvent,
    });

  let runtime: HarnessRuntime = buildRuntime();

  const pushUser = (text: string): void => {
    userSeq += 1;
    source.push(
      ItemSchema.parse({
        id: ids.next('itm'),
        turnId: turnIdSeed,
        threadId,
        seq: userSeq,
        createdAt: Date.now(),
        type: 'user-message',
        text,
      }),
    );
  };

  const submit = (text: string): void => {
    if (running || text.trim() === '') return;
    running = true;
    pushUser(text);
    setView({ status: baseStatus('busy'), approval: null });

    // Reset the per-turn streaming row.
    streamText = '';
    streamItemId = '';

    const controller = new AbortController();
    abort = controller;
    const history = reconstructHistory(store, threadId);

    void runtime
      .runTurn({
        threadId,
        correlationId: ids.next('cor') as CorrelationId,
        userText: text,
        history,
        signal: controller.signal,
      })
      .then((outcome) => {
        if (outcome.finalText && streamText === '') {
          // A turn that ended with text the tee never saw (e.g. a non-streaming transport): show it.
          source.push(
            ItemSchema.parse({
              id: ids.next('itm'),
              turnId: turnIdSeed,
              threadId,
              seq: 0,
              createdAt: Date.now(),
              type: 'assistant-message',
              text: outcome.finalText,
              complete: true,
            }),
          );
        }
      })
      .catch((err: unknown) => {
        source.push(
          ItemSchema.parse({
            id: ids.next('itm'),
            turnId: turnIdSeed,
            threadId,
            seq: 0,
            createdAt: Date.now(),
            type: 'error',
            message: sanitize(err instanceof Error ? err.message : String(err), {
              origin: 'tool',
              multiline: true,
              maxLength: 400,
            }).text,
          }),
        );
      })
      .finally(() => {
        running = false;
        abort = null;
        resolveApproval = null;
        setView({ status: baseStatus('idle'), approval: null });
      });
  };

  return {
    source,
    getView: () => view,
    subscribeView(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit,
    cycleMode() {
      // Advance the REQUEST and re-derive real authority; the ceiling clamps it (yolo under
      // maxProfile:plan comes back as plan). Rebuild the runtime so the change takes effect on the
      // NEXT turn — an in-flight turn already captured the previous runtime and is left untouched.
      requestedProfile = nextProfile(requestedProfile);
      authority = loadAuthorityFor(requestedProfile);
      runtime = buildRuntime();
      // Reflect the CLAMPED profile (authority.profile) immediately, preserving activity/approval.
      setView({ status: baseStatus(view.status.activity), approval: view.approval });
    },
    interrupt() {
      abort?.abort(new Error('interrupted by user'));
    },
    decide(decision) {
      const resolve = resolveApproval;
      resolveApproval = null;
      setView({ status: view.status, approval: null });
      if (resolve === null) return;
      resolve(
        decision === 'deny'
          ? { kind: 'denied', reason: 'the user denied this action' }
          : { kind: 'approved', scope: decision },
      );
    },
    dumpDurable(write: (line: string) => void) {
      // The durable transcript already lives in the event store; a resuming process reads the DB.
      // Nothing to emit on stderr for the live path.
      void write;
    },
  };
}
