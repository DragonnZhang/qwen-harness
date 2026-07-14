/**
 * Reading the workspace's durable sessions for the picker (UI-10).
 *
 * The session picker lists ACTUAL threads from the on-disk event store — the same store the live
 * `run` mode writes to (`<cwd>/.qwen-harness/sessions.sqlite`). It reuses the CLI's `listSessions`
 * (the authoritative projection of the log) and reads each thread's first `turn-started` for a
 * one-line recap. Both the thread NAME and the first PROMPT are untrusted (a name can be model- or
 * user-authored; a prompt is user text), so each is `sanitize`d into `SafeText` here, at the read
 * boundary, before it can ever reach the terminal. The turn count and the timestamp are our own
 * derived chrome.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listSessions } from '@qwen-harness/cli';
import { sanitize, type SafeText, type ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';

/** One row the picker renders. Untrusted fields are `SafeText`; the rest is our own chrome. */
export interface SessionRow {
  readonly threadId: ThreadId;
  readonly name: SafeText;
  readonly firstPrompt: SafeText;
  readonly when: string;
  readonly turns: number;
}

/** A coarse "N ago" for the row. Trusted chrome — computed from our clock, never from stored text. */
function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Load the workspace's durable sessions, newest first. Returns `[]` (never throws) when the store
 * does not exist yet — a fresh workspace simply has nothing to resume. The store is opened
 * read-only for the duration of the read and closed before we return, so the resuming live turn can
 * open its own connection to the same file without contending for the writer.
 */
export function loadSessionRows(cwd: string, now: number = Date.now()): readonly SessionRow[] {
  const dbPath = join(cwd, '.qwen-harness', 'sessions.sqlite');
  if (!existsSync(dbPath)) return [];

  // The read never appends, so the injected ids/clock are inert here; they exist only to satisfy
  // the store's constructor. We still avoid ambient randomness (a counter, not Math.random).
  let counter = 0;
  const store = new EventStore({
    path: dbPath,
    clock: { now: () => now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    ids: {
      next: (prefix) => `${prefix}_${now.toString(36)}${(counter++).toString(36).padStart(4, '0')}`,
    },
  });

  try {
    return listSessions(store).map((summary): SessionRow => {
      let firstPrompt: string | null = null;
      for (const event of store.readThread(summary.threadId)) {
        if (event.payload.type === 'turn-started') {
          firstPrompt = event.payload.userText;
          break;
        }
      }
      return {
        threadId: summary.threadId,
        name: sanitize(summary.name ?? '(untitled session)', {
          origin: 'user',
          multiline: false,
          maxLength: 60,
        }).text,
        firstPrompt: sanitize(firstPrompt ?? '(no messages yet)', {
          origin: 'user',
          multiline: false,
          maxLength: 80,
        }).text,
        when: relativeTime(summary.updatedAt, now),
        turns: summary.turns,
      };
    });
  } finally {
    store.close();
  }
}
