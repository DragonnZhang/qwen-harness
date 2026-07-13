import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CANARY_API_KEY } from '@qwen-harness/testkit';

import { defaultProvider, loadRunAuthority } from '../../src/index.ts';

/**
 * `config.baseUrl` and `config.transport` must actually reach the endpoint the provider talks to.
 *
 * They used to be resolved by `@qwen-harness/config`, printed by `doctor`, and then dropped: the CLI
 * built `new DashScopeProvider()` with no options, so the provider always used its frozen default
 * endpoint regardless of configuration. That is the "loaded but not wired" failure class this
 * project keeps finding — a setting that silently does nothing is worse than no setting. Golden path
 * 10 (fresh install) surfaced it: the installed binary could only ever reach the live model.
 *
 * This test proves the whole chain — config file → resolved authority → provider → the URL an actual
 * request goes to — by capturing the request with an injected fetch. No socket, no live call.
 */

let dir: string;
let home: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-provider-config-'));
  home = join(dir, 'home');
  project = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, '.qwen-harness'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProjectConfig(doc: unknown): void {
  writeFileSync(join(project, '.qwen-harness', 'config.json'), JSON.stringify(doc), 'utf8');
}

function authorityWith(config: Record<string, unknown>) {
  writeProjectConfig(config);
  return loadRunAuthority({
    projectRoot: project,
    homeDir: home,
    // A present (canary) key so the provider attempts a request instead of failing closed on a
    // missing credential. The value never leaves this process and is asserted-absent below.
    env: { DASHSCOPE_API_KEY: CANARY_API_KEY },
    cli: {},
  });
}

/**
 * Drive one streamed request through the provider and return the URL fetch was asked to hit.
 *
 * The URL is captured at the moment `fetch` is called — BEFORE the response body is parsed — so the
 * drain below only exists to actually issue the request. Whether the (deliberately minimal) SSE body
 * satisfies a given transport's finish contract is irrelevant to what we assert; a drain error is
 * swallowed. We never inspect the Authorization header: the provider reads the real credential from
 * `process.env` at its own boundary, and capturing that header would mean handling the live key.
 */
async function capturedRequestUrl(authority: ReturnType<typeof authorityWith>): Promise<string> {
  let seenUrl = '';
  const fetchImpl = (url: string): Promise<Response> => {
    seenUrl = url;
    const body = `event: response.completed\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n`;
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };

  const provider = defaultProvider(authority, fetchImpl as never);
  const stream = provider.stream({
    model: 'qwen3.7-max',
    input: [{ type: 'message', role: 'user', text: 'hi' }],
    tools: [],
    instructions: 'be terse',
    signal: new AbortController().signal,
  } as never);
  try {
    for await (const _ of stream) {
      void _;
    }
  } catch {
    // The request was issued (that is all we need); the minimal body may not satisfy every
    // transport's finish contract, which is not what this test is about.
  }
  return seenUrl;
}

describe('config.baseUrl / transport actually reach the provider request', () => {
  it('a configured baseUrl is the host the request goes to', async () => {
    const authority = authorityWith({ baseUrl: 'https://proxy.internal.example/v1' });
    expect(authority.config.baseUrl.value).toBe('https://proxy.internal.example/v1');

    const url = await capturedRequestUrl(authority);
    expect(url.startsWith('https://proxy.internal.example/v1')).toBe(true);
    expect(url).not.toContain('dashscope.aliyuncs.com'); // NOT the frozen default
  });

  it('transport: responses hits /responses; transport: chat hits /chat/completions', async () => {
    const responses = await capturedRequestUrl(
      authorityWith({ baseUrl: 'https://h.example', transport: 'responses' }),
    );
    expect(responses).toBe('https://h.example/responses');

    const chat = await capturedRequestUrl(
      authorityWith({ baseUrl: 'https://h.example', transport: 'chat' }),
    );
    expect(chat).toBe('https://h.example/chat/completions');
  });

  it('with no config, the frozen default endpoint is still used (nothing regressed)', async () => {
    const url = await capturedRequestUrl(authorityWith({}));
    expect(url).toContain('dashscope.aliyuncs.com');
  });

  it('the resolved-config surface never contains a credential value (only the env var name)', () => {
    // Not an Authorization-header test: the provider reads the real key from process.env at its own
    // boundary, and we deliberately never capture that. This asserts the OTHER half — the config the
    // rest of the app passes around carries the env var NAME, never a value.
    const authority = authorityWith({
      baseUrl: 'https://h.example',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
    });
    const serialized = JSON.stringify(authority.config);
    expect(serialized).toContain('DASHSCOPE_API_KEY'); // the NAME is fine to carry
    expect(serialized).not.toContain(CANARY_API_KEY); // a VALUE is never here
  });
});
