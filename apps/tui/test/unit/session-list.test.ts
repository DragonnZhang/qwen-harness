import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CorrelationId, ItemId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { SequentialIds, USER_ACTOR, MODEL_ACTOR } from '@qwen-harness/testkit';

import { loadSessionRows } from '../../src/session-list.ts';

/**
 * UI-10 (unit): `loadSessionRows` is the read boundary the session picker renders. It reads the
 * workspace's REAL durable event store, lists its threads, and — critically — sanitizes the
 * untrusted session name and first prompt into `SafeText` before they can reach the terminal. This
 * unit test drives that boundary directly (the PTY test proves the picker end to end).
 */

let dir: string;
let store: EventStore;
let ids: SequentialIds;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-session-list-'));
  ids = new SequentialIds();
  // The picker reads exactly this path: <cwd>/.qwen-harness/sessions.sqlite.
  mkdirSync(join(dir, '.qwen-harness'), { recursive: true });
  store = new EventStore({
    path: join(dir, '.qwen-harness', 'sessions.sqlite'),
    clock: { now: () => 1_700_000_000_000 },
    ids,
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(threadId: string, name: string | null, prompt: string): void {
  const base = { threadId: threadId as ThreadId, correlationId: 'cor_000001' as CorrelationId };
  store.append({
    ...base,
    permissionProfile: 'ask',
    actor: USER_ACTOR,
    payload: { type: 'thread-created', cwd: dir, canonicalRepo: dir, name },
  });
  store.append({
    ...base,
    permissionProfile: 'ask',
    actor: USER_ACTOR,
    turnId: threadId.replace('thr', 'trn') as TurnId,
    payload: { type: 'turn-started', userText: prompt },
  });
}

describe('loadSessionRows (UI-10)', () => {
  it('returns an empty list when no store exists (no throw)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qh-empty-'));
    expect(loadSessionRows(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('lists every durable session with its first prompt and turn count', () => {
    seed('thr_000001', 'first session', 'fix the failing test');
    seed('thr_000002', null, 'add a logger module');

    const rows = loadSessionRows(dir, 1_700_000_060_000);
    expect(rows.length).toBe(2);

    const byId = new Map(rows.map((r) => [r.threadId, r]));
    const a = byId.get('thr_000001' as ThreadId);
    const b = byId.get('thr_000002' as ThreadId);
    expect(String(a?.name)).toContain('first session');
    expect(String(a?.firstPrompt)).toContain('fix the failing test');
    // A null name falls back to a labeled placeholder, never a crash or empty render.
    expect(String(b?.name)).toContain('untitled');
    expect(String(b?.firstPrompt)).toContain('add a logger module');
    // Relative time is trusted chrome computed from the clock (60s after the seed).
    expect(a?.when).toContain('ago');
  });

  it('sanitizes a HOSTILE session name / prompt — no escape survives into the row', () => {
    const esc = String.fromCharCode(27);
    seed('thr_000003', `evil${esc}[31mRED`, `paste${esc}]52;c;BASE64${esc}\\ done`);

    const rows = loadSessionRows(dir);
    const row = rows.find((r) => r.threadId === ('thr_000003' as ThreadId));
    // The visible text survives; the control sequence does NOT (SafeText from the sanitizer).
    expect(String(row?.name)).toContain('RED');
    expect(String(row?.name)).not.toContain('[31m');
    expect(String(row?.firstPrompt)).toContain('done');
    expect(String(row?.firstPrompt)).not.toContain(']52;');
  });

  it('an item-appended tool result does not break the first-prompt read', () => {
    seed('thr_000004', 'with a tool call', 'read a.ts');
    store.append({
      threadId: 'thr_000004' as ThreadId,
      correlationId: 'cor_000001' as CorrelationId,
      permissionProfile: 'ask',
      actor: MODEL_ACTOR,
      turnId: 'trn_000004' as TurnId,
      itemId: 'itm_000010' as ItemId,
      payload: {
        type: 'item-appended',
        item: {
          type: 'assistant-message',
          id: 'itm_000010' as ItemId,
          turnId: 'trn_000004' as TurnId,
          threadId: 'thr_000004' as ThreadId,
          seq: 0,
          createdAt: 1_700_000_000_000,
          text: 'here you go',
          complete: true,
        },
      },
    });
    const rows = loadSessionRows(dir);
    const row = rows.find((r) => r.threadId === ('thr_000004' as ThreadId));
    expect(String(row?.firstPrompt)).toContain('read a.ts'); // the FIRST prompt, not the reply
    expect(row?.turns).toBeGreaterThanOrEqual(1);
  });
});
