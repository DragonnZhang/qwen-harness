import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProviderStreamEvent } from '@qwen-harness/provider-core';

/**
 * Replay harness for the REAL captured contract fixtures.
 *
 * These are the bytes checkpoint 0 recorded from the live DashScope service, not a hand-written
 * approximation of them. The fixtures are stored as JSONL (one decoded SSE payload per line), so
 * this module re-frames them back into the SSE wire format the parser actually has to survive —
 * `event:` / `data:` / blank line — rather than letting a test bypass the parser and feed the
 * normalizer pre-parsed objects. A test that skipped the framing would not be a contract test.
 */

const FIXTURE_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'fixtures/provider/dashscope',
);

function readJsonl(name: string): unknown[] {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): unknown => JSON.parse(line));
}

/** The Responses fixture: `{ event, data }` per line, exactly as the SSE stream delivered them. */
export function responsesFixtureSse(): string {
  const frames = readJsonl('responses-stream-text-reasoning-tool.jsonl') as {
    event: string;
    data: unknown;
  }[];
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

/** The Chat fixture: one unnamed data-only frame per chunk, terminated by `[DONE]`. */
export function chatFixtureSse(): string {
  const chunks = readJsonl('chat-stream-text-reasoning-tool.jsonl');
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

export interface ErrorFixture {
  readonly http: number;
  readonly body: unknown;
}

export function errorFixtures(): Record<string, ErrorFixture> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'errors.json'), 'utf8')) as Record<
    string,
    ErrorFixture
  >;
}

export interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface FakeFetch {
  (input: unknown, init?: unknown): Promise<Response>;
  readonly calls: RecordedCall[];
}

interface FakeResponse {
  readonly status?: number;
  readonly sse?: string;
  readonly json?: unknown;
  readonly headers?: Record<string, string>;
}

/** A fetch that records what was sent and replays a canned response. Never opens a socket. */
export function fakeFetch(response: FakeResponse): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = (input: unknown, init?: unknown): Promise<Response> => {
    const requestInit = (init ?? {}) as { headers?: Record<string, string>; body?: string };
    calls.push({
      url: String(input),
      headers: requestInit.headers ?? {},
      body: JSON.parse(requestInit.body ?? '{}') as Record<string, unknown>,
    });
    const status = response.status ?? 200;
    const headers = new Headers(response.headers ?? {});
    if (response.sse !== undefined) {
      headers.set('content-type', 'text/event-stream');
      return Promise.resolve(new Response(response.sse, { status, headers }));
    }
    headers.set('content-type', 'application/json');
    return Promise.resolve(new Response(JSON.stringify(response.json ?? {}), { status, headers }));
  };
  return Object.assign(impl, { calls }) as FakeFetch;
}

/**
 * Drain a provider stream. The provider's failure contract is "emit a terminal `error` event AND
 * throw the same error", so a helper that only collected events would silently pass a test that
 * should have failed. This returns both halves and asserts nothing about them.
 */
export async function drain(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<{ events: ProviderStreamEvent[]; thrown: unknown }> {
  const events: ProviderStreamEvent[] = [];
  let thrown: unknown = null;
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    thrown = error;
  }
  return { events, thrown };
}
