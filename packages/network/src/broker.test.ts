import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NETWORK_POLICY,
  NetworkBroker,
  NetworkError,
  type FetchImpl,
  type FetchResponse,
} from './index.ts';

/** A fake fetch that plays a scripted sequence of responses (for redirect chains). */
function fakeFetch(responses: Partial<FetchResponse>[]): { impl: FetchImpl; urls: string[] } {
  let i = 0;
  const urls: string[] = [];
  const impl: FetchImpl = (url) => {
    urls.push(url);
    const r = responses[i++] ?? { status: 200 };
    return Promise.resolve({
      status: r.status ?? 200,
      headers: { get: (n: string) => r.headers?.get(n) ?? null },
      body: r.body ?? null,
      text: () => (r.text ? r.text() : Promise.resolve('body')),
    });
  };
  return { impl, urls };
}

function headers(map: Record<string, string>) {
  return { get: (n: string) => map[n.toLowerCase()] ?? null };
}

const ESC = '\u001b';

describe('NetworkBroker policy', () => {
  it('fetches an allowed URL and sanitizes the body', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        headers: headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(`hello ${ESC}[2Jworld`),
      },
    ]);
    const broker = new NetworkBroker(impl);
    const result = await broker.fetch('https://example.com/page');
    expect(result.status).toBe(200);
    // The ANSI escape from the fetched page was neutralized — a page is untrusted (TL-14).
    expect(result.content).not.toContain(ESC);
    expect(result.content).toContain('world');
  });

  it('denies a non-http scheme', async () => {
    const { impl } = fakeFetch([{}]);
    const broker = new NetworkBroker(impl);
    await expect(broker.fetch('file:///etc/passwd')).rejects.toThrow(NetworkError);
    await expect(broker.fetch('gopher://x')).rejects.toThrow(/scheme/);
  });

  it('respects an allowlist', async () => {
    const { impl } = fakeFetch([
      { status: 200, headers: headers({ 'content-type': 'text/html' }) },
    ]);
    const broker = new NetworkBroker(impl, {
      ...DEFAULT_NETWORK_POLICY,
      allowHosts: ['example.com'],
    });
    await expect(broker.fetch('https://evil.test/x')).rejects.toThrow(/allowlist/);
    await expect(broker.fetch('https://api.example.com/x')).resolves.toBeDefined();
  });

  it('enforces content-type', async () => {
    const { impl } = fakeFetch([
      { status: 200, headers: headers({ 'content-type': 'application/octet-stream' }) },
    ]);
    const broker = new NetworkBroker(impl);
    await expect(broker.fetch('https://example.com/binary')).rejects.toThrow(/content-type/);
  });

  it('caps the download size while streaming', async () => {
    async function* big() {
      for (let i = 0; i < 100; i++) yield new Uint8Array(1024);
    }
    const { impl } = fakeFetch([
      { status: 200, headers: headers({ 'content-type': 'text/plain' }), body: big() },
    ]);
    const broker = new NetworkBroker(impl, { ...DEFAULT_NETWORK_POLICY, maxDownloadBytes: 4096 });
    const result = await broker.fetch('https://example.com/big');
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(4096 + 64);
  });
});
