import type { HarnessEvent, ThreadId } from '@qwen-harness/protocol';
import { exportJsonl } from '@qwen-harness/storage';
import type { EventStore } from '@qwen-harness/storage';
import type { ModelInputItem } from '@qwen-harness/provider-core';

/**
 * Session operations built directly on the durable event log (SS-02, SS-03).
 *
 * Local history is authoritative (PV-08): a session is resumed by reconstructing the model
 * conversation from the events the store already holds, never by trusting a remote `previous_response_id`.
 * Because the log is the source of truth, resume/fork/export are all just different reads of it.
 */

export interface SessionSummary {
  readonly threadId: ThreadId;
  readonly name: string | null;
  readonly updatedAt: number;
  readonly turns: number;
  readonly forkedFrom: ThreadId | null;
}

export function listSessions(store: EventStore): SessionSummary[] {
  return store.listThreads().map((t) => {
    const events = store.readThread(t.id);
    const turns = events.filter((e) => e.payload.type === 'turn-started').length;
    return {
      threadId: t.id,
      name: t.name,
      updatedAt: t.updatedAt,
      turns,
      forkedFrom: t.forkedFrom?.threadId ?? null,
    };
  });
}

/**
 * Rebuild the model conversation for a thread from its durable items. This is what makes resume
 * work without any remote state: the assistant messages, the tool calls, and the tool outputs the
 * model needs to see are all replayed straight out of the log, paired by their exact call IDs.
 */
export function reconstructHistory(store: EventStore, threadId: ThreadId): ModelInputItem[] {
  const history: ModelInputItem[] = [];

  for (const event of store.readThread(threadId)) {
    const p = event.payload;
    if (p.type === 'turn-started') {
      history.push({ type: 'message', role: 'user', text: p.userText });
      continue;
    }
    if (p.type !== 'item-appended') continue;
    const item = p.item;

    switch (item.type) {
      case 'assistant-message':
        if (item.text.length > 0)
          history.push({ type: 'message', role: 'assistant', text: item.text });
        break;
      case 'tool-call':
        history.push({
          type: 'function-call',
          callId: item.callId,
          name: item.toolName,
          argumentsJson: item.argumentsJson,
        });
        break;
      case 'tool-result':
        history.push({
          type: 'function-output',
          callId: item.callId,
          name: item.toolName,
          output: item.preview,
        });
        break;
      default:
        // reasoning summaries, usage, etc. are not part of the model INPUT history.
        break;
    }
  }

  return history;
}

export interface ForkResult {
  readonly newThreadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly copiedEvents: number;
}

/**
 * Fork a thread: create a NEW thread whose history is a copy of the original up to a point, with a
 * recorded lineage. The original is never modified (SS-03). Fork gives the new thread its own
 * identity, so two lines of work can diverge from a shared past.
 */
export function forkSession(
  store: EventStore,
  fromThreadId: ThreadId,
  newThreadId: ThreadId,
  opts: { atSeq?: number; now: number; actorId: string; ids: { next(prefix: string): string } },
): ForkResult {
  const source = store.getThread(fromThreadId);
  if (source === undefined) throw new Error(`no such session: ${fromThreadId}`);

  const events = store.readThread(fromThreadId);
  const cutoff = opts.atSeq ?? events.at(-1)?.seq ?? 0;

  const base = {
    threadId: newThreadId,
    correlationId: opts.ids.next('cor') as never,
    permissionProfile: source.permissionProfile,
    actor: { kind: 'system' as const, id: opts.actorId as never },
  };

  store.append({
    ...base,
    payload: {
      type: 'thread-created',
      cwd: source.cwd,
      canonicalRepo: source.canonicalRepo,
      name: source.name ? `${source.name} (fork)` : null,
    },
  });
  store.append({ ...base, payload: { type: 'thread-forked', fromThreadId, atSeq: cutoff } });

  // The projection tables key turns and items by their OWN ids, so the fork cannot reuse the
  // source's ids without colliding. Remint them consistently: a source turn/item id maps to one
  // fresh id, used for both the envelope and the item body. The reconstructed HISTORY is unchanged
  // — history is built from text/role and the provider call id, none of which we touch.
  const idMap = new Map<string, string>();
  const remap = (prefix: string, old: string): string => {
    const existing = idMap.get(old);
    if (existing !== undefined) return existing;
    const fresh = opts.ids.next(prefix);
    idMap.set(old, fresh);
    return fresh;
  };

  let copied = 0;
  for (const event of events) {
    if (event.seq > cutoff) break;
    if (event.payload.type === 'turn-started') {
      const newTurnId = event.turnId ? remap('trn', event.turnId) : opts.ids.next('trn');
      store.append({ ...base, turnId: newTurnId as never, payload: event.payload });
      copied++;
    } else if (event.payload.type === 'item-appended') {
      const item = event.payload.item;
      const newTurnId = remap('trn', item.turnId);
      const newItemId = remap('itm', item.id);
      store.append({
        ...base,
        turnId: newTurnId as never,
        itemId: newItemId as never,
        payload: {
          type: 'item-appended',
          item: {
            ...item,
            id: newItemId as never,
            turnId: newTurnId as never,
            threadId: newThreadId,
          },
        },
      });
      copied++;
    }
  }

  return { newThreadId, fromThreadId, copiedEvents: copied };
}

/** Export a session as the stable public JSONL schema (SS-06), independent of internal tables. */
export function exportSession(store: EventStore, threadId: ThreadId, now: number): string {
  const thread = store.getThread(threadId);
  if (thread === undefined) throw new Error(`no such session: ${threadId}`);
  return exportJsonl(store, { threadId, exportedAt: now });
}

/** The last assistant text in a thread, for a quick recap. */
export function lastAssistantText(events: readonly HarnessEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]!.payload;
    if (p.type === 'item-appended' && p.item.type === 'assistant-message') return p.item.text;
  }
  return null;
}
