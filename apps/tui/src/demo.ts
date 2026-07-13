/**
 * A scripted transcript for the standalone entry point.
 *
 * This is a DATA source, not a fake control: every component it feeds is the real one. In
 * production the runtime supplies items on this same `RuntimeSource` port; here a fixed sequence
 * lets `qwen-harness-tui` render a representative transcript with no live model — which is exactly
 * what the PTY restoration gate (UI-13) exercises.
 */

import { ItemSchema, type Item } from '@qwen-harness/protocol';

let seq = 0;
function item(fields: Record<string, unknown>): Item {
  seq += 1;
  return ItemSchema.parse({
    turnId: 'trn_demo01',
    threadId: 'thr_demo01',
    seq,
    createdAt: 0,
    ...fields,
  });
}

const DIFF = [
  'diff --git a/greeting.ts b/greeting.ts',
  '--- a/greeting.ts',
  '+++ b/greeting.ts',
  '@@ -1,2 +1,2 @@',
  ' export function greet() {',
  '-  return "hi";',
  '+  return "hello, world";',
  '}',
].join('\n');

export const DEMO_ITEMS: readonly Item[] = [
  item({
    id: 'itm_user01',
    type: 'user-message',
    text: 'Update the greeting and show me the diff.',
  }),
  item({
    id: 'itm_asst01',
    type: 'assistant-message',
    complete: true,
    text: 'Here is the change. I updated `greet()` to return a fuller message:\n\n```ts\nreturn "hello, world";\n```',
  }),
  item({
    id: 'itm_call01',
    type: 'tool-call',
    callId: 'call_demo1',
    toolName: 'apply_patch',
    argumentsJson: '{"path":"greeting.ts"}',
    arguments: { path: 'greeting.ts' },
  }),
  item({
    id: 'itm_result01',
    type: 'tool-result',
    callId: 'call_demo1',
    toolName: 'apply_patch',
    ok: true,
    preview: DIFF,
    outputRef: null,
    truncated: false,
    durationMs: 8,
    errorCategory: null,
  }),
  item({
    id: 'itm_usage01',
    type: 'usage',
    inputTokens: 412,
    outputTokens: 96,
    totalTokens: 508,
    reasoningTokens: 12,
    cachedInputTokens: 128,
  }),
];
