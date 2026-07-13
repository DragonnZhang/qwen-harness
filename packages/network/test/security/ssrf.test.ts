import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NETWORK_POLICY,
  NetworkBroker,
  NetworkError,
  type FetchImpl,
} from '../../src/index.ts';

function redirectingFetch(location: string): FetchImpl {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return Promise.resolve({
        status: 302,
        headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
        body: null,
        text: () => Promise.resolve(''),
      });
    }
    return Promise.resolve({
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
      body: null,
      text: () => Promise.resolve('SECRET'),
    });
  };
}

describe('SSRF guard (the security-critical part)', () => {
  it.each([
    'http://localhost/x',
    'http://127.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.100/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://metadata.google.internal/x',
  ])('refuses a direct request to a private/metadata address: %s', async (url) => {
    const broker = new NetworkBroker(() => Promise.reject(new Error('should not be called')));
    await expect(broker.fetch(url)).rejects.toThrow(NetworkError);
  });

  it('refuses a REDIRECT to the cloud metadata endpoint (the classic SSRF)', async () => {
    // The origin is allowed, but it redirects to the metadata service. Following it blindly would
    // leak cloud credentials — the broker must re-check the redirect target and refuse.
    const broker = new NetworkBroker(
      redirectingFetch('http://169.254.169.254/latest/meta-data/iam/'),
    );
    await expect(broker.fetch('https://example.com/redirector')).rejects.toThrow(
      /private|metadata/i,
    );
  });

  it('refuses a redirect to a denied host', async () => {
    const broker = new NetworkBroker(redirectingFetch('https://evil.test/steal'), {
      ...DEFAULT_NETWORK_POLICY,
      denyHosts: ['evil.test'],
    });
    await expect(broker.fetch('https://example.com/redirector')).rejects.toThrow(/denied/i);
  });

  it('stops after too many redirects', async () => {
    let n = 0;
    const impl: FetchImpl = () =>
      Promise.resolve({
        status: 302,
        headers: {
          get: (h: string) =>
            h.toLowerCase() === 'location' ? `https://h${n++}.example.com/` : null,
        },
        body: null,
        text: () => Promise.resolve(''),
      });
    const broker = new NetworkBroker(impl, { ...DEFAULT_NETWORK_POLICY, maxRedirects: 3 });
    await expect(broker.fetch('https://start.example.com/')).rejects.toThrow(/redirect/i);
  });
});

// The POST-with-body egress (`send`) is a SECOND path to the network. It MUST be guarded exactly as
// `fetch` (the GET path) is: the whole point of routing MCP HTTP/OAuth through the broker is that a
// POST cannot reach an address a GET could not. These tests assert the guard is the SAME by
// exercising `send` against every case the GET path refuses.
describe('SSRF guard applies to POST-with-body egress identically (security-critical)', () => {
  it.each([
    'http://localhost/token',
    'http://127.0.0.1/token',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.100/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://metadata.google.internal/x',
  ])('refuses a direct POST to a private/metadata address: %s', async (url) => {
    const broker = new NetworkBroker(() => Promise.reject(new Error('should not be called')));
    await expect(
      broker.send({ method: 'POST', url, body: '{"jsonrpc":"2.0"}' }),
    ).rejects.toThrow(NetworkError);
  });

  it('refuses a non-http scheme on POST', async () => {
    const broker = new NetworkBroker(() => Promise.reject(new Error('should not be called')));
    await expect(broker.send({ method: 'POST', url: 'file:///etc/passwd' })).rejects.toThrow(
      /scheme/,
    );
  });

  it('refuses a POST whose redirect targets the cloud metadata endpoint (classic SSRF)', async () => {
    // The origin is allowed; it 302s to the metadata service. `send` re-checks the hop and refuses,
    // never re-issuing the body to 169.254.169.254 — exactly as the GET path does.
    const broker = new NetworkBroker(
      redirectingFetch('http://169.254.169.254/latest/meta-data/iam/'),
    );
    await expect(
      broker.send({ method: 'POST', url: 'https://example.com/redirector', body: 'x' }),
    ).rejects.toThrow(/private|metadata/i);
  });

  it('refuses a POST redirected to a denied host', async () => {
    const broker = new NetworkBroker(redirectingFetch('https://evil.test/steal'), {
      ...DEFAULT_NETWORK_POLICY,
      denyHosts: ['evil.test'],
    });
    await expect(
      broker.send({ method: 'POST', url: 'https://example.com/redirector', body: 'x' }),
    ).rejects.toThrow(/denied/i);
  });

  it('enforces the allowlist on POST just as on GET', async () => {
    const broker = new NetworkBroker(
      () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: null,
          text: () => Promise.resolve('{}'),
          headerEntries: () => [],
        }),
      { ...DEFAULT_NETWORK_POLICY, allowHosts: ['example.com'] },
    );
    await expect(broker.send({ method: 'POST', url: 'https://evil.test/x' })).rejects.toThrow(
      /allowlist/,
    );
    // An allowed host is reached and its raw (unsanitized) body returned byte-exact.
    const res = await broker.send({ method: 'POST', url: 'https://api.example.com/token' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });
});
