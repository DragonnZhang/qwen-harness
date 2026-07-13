import { NetworkBroker, NetworkError, type FetchResponse } from '@qwen-harness/network';
import { describe, expect, it } from 'vitest';

import { brokeredGateway, SseParser } from './http-gateway.ts';

function jsonResponse(body: string): FetchResponse {
  return {
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    body: null,
    text: () => Promise.resolve(body),
    headerEntries: () => [['content-type', 'application/json']],
  };
}

describe('brokered HTTP gateway (routes everything through the network broker)', () => {
  it('routes a discovery GET through the broker sanitizing path', async () => {
    let fetchedUrl = '';
    const broker = new NetworkBroker((url) => {
      fetchedUrl = url;
      return Promise.resolve(jsonResponse('{"ok":true}'));
    });
    const gateway = brokeredGateway({ broker });
    const res = await gateway.send({ method: 'GET', url: 'https://auth.example/.well-known/x' });
    expect(fetchedUrl).toContain('auth.example');
    expect(res.body).toContain('"ok":true');
  });

  it('routes a POST through the broker raw egress and returns the body byte-exact', async () => {
    let seenMethod = '';
    let seenBody: string | undefined;
    const broker = new NetworkBroker((_url, init) => {
      seenMethod = init.method ?? 'GET';
      seenBody = init.body;
      return Promise.resolve(jsonResponse('{"jsonrpc":"2.0","id":1,"result":{}}'));
    });
    const gateway = brokeredGateway({ broker });
    const res = await gateway.send({
      method: 'POST',
      url: 'https://api.example/mcp',
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(seenMethod).toBe('POST');
    expect(seenBody).toContain('ping');
    expect(res.body).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
  });

  it('a POST to a loopback/SSRF address is refused by the broker before any socket', async () => {
    // No fake response is scripted: if the guard failed to fire, the fetch would be invoked and the
    // reject below would come from the wrong place. The broker refuses at policy time.
    const broker = new NetworkBroker(() => Promise.reject(new Error('must not be reached')));
    const gateway = brokeredGateway({ broker });
    await expect(
      gateway.send({ method: 'POST', url: 'http://127.0.0.1/token', body: 'x' }),
    ).rejects.toBeInstanceOf(NetworkError);
    await expect(
      gateway.send({ method: 'POST', url: 'http://169.254.169.254/latest', body: 'x' }),
    ).rejects.toBeInstanceOf(NetworkError);
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
