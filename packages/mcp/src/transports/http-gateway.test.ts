import { NetworkBroker, NetworkError, type FetchResponse } from '@qwen-harness/network';
import { describe, expect, it } from 'vitest';

import { assertUrlAllowed, brokeredGateway, SseParser, type RawHttp } from './http-gateway.ts';

function jsonResponse(body: string): FetchResponse {
  return {
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    body: null,
    text: () => Promise.resolve(body),
  };
}

describe('brokered HTTP gateway (routes through the network broker)', () => {
  it('routes a discovery GET through the real NetworkBroker', async () => {
    let fetchedUrl = '';
    const broker = new NetworkBroker((url) => {
      fetchedUrl = url;
      return Promise.resolve(jsonResponse('{"ok":true}'));
    });
    const rawHttp: RawHttp = () => Promise.reject(new Error('raw should not be used for GET'));
    const gateway = brokeredGateway({ broker, rawHttp });
    const res = await gateway.send({ method: 'GET', url: 'https://auth.example/.well-known/x' });
    expect(fetchedUrl).toContain('auth.example');
    expect(res.body).toContain('"ok":true');
  });

  it('refuses a POST to a loopback/SSRF address exactly as the broker would', () => {
    expect(() => assertUrlAllowed('http://127.0.0.1/token', { ...DEFAULT })).toThrow(NetworkError);
    expect(() => assertUrlAllowed('http://169.254.169.254/latest', { ...DEFAULT })).toThrow(
      NetworkError,
    );
    expect(() => assertUrlAllowed('file:///etc/passwd', { ...DEFAULT })).toThrow(NetworkError);
    // A normal HTTPS host is allowed.
    expect(assertUrlAllowed('https://api.example/token', { ...DEFAULT }).hostname).toBe(
      'api.example',
    );
  });

  it('a POST through the gateway is guarded before the raw call runs', async () => {
    const broker = new NetworkBroker(() => Promise.reject(new Error('unused')));
    let rawCalled = false;
    const rawHttp: RawHttp = () => {
      rawCalled = true;
      return Promise.reject(new Error('unreachable'));
    };
    const gateway = brokeredGateway({ broker, rawHttp });
    await expect(
      gateway.send({ method: 'POST', url: 'http://127.0.0.1/token', body: 'x' }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(rawCalled).toBe(false);
  });
});

describe('SSE parser', () => {
  it('decodes events across chunk boundaries', () => {
    const parser = new SseParser();
    expect(parser.push('data: hel')).toEqual([]);
    const events = parser.push('lo\n\nevent: tick\ndata: 1\nid: 7\n\n');
    expect(events[0]).toMatchObject({ event: 'message', data: 'hello' });
    expect(events[1]).toMatchObject({ event: 'tick', data: '1', id: '7' });
  });

  it('ignores comment/heartbeat lines', () => {
    const parser = new SseParser();
    expect(parser.push(': keepalive\n\n')).toEqual([]);
  });
});

const DEFAULT = {
  allowHosts: [],
  denyHosts: [],
  blockPrivateAddresses: true,
  maxRedirects: 5,
  maxDownloadBytes: 1_000_000,
  allowedContentTypes: ['application/json'],
} as const;
