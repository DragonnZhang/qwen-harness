import { describe, expect, it, vi } from 'vitest';

import {
  JSONRPC_VERSION,
  JsonRpcCallError,
  JsonRpcPeer,
  decodeMessage,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type PeerChannel,
} from './jsonrpc.ts';
import { McpError } from './errors.ts';

/** A controllable in-memory channel: records what the peer sends, lets a test deliver replies. */
class FakeChannel implements PeerChannel {
  readonly sent: JsonRpcMessage[] = [];
  #onMessage: ((m: JsonRpcMessage) => void) | null = null;
  #onClose: ((err?: Error) => void) | null = null;
  sendImpl: (m: JsonRpcMessage) => Promise<void> = () => Promise.resolve();

  send(m: JsonRpcMessage): Promise<void> {
    this.sent.push(m);
    return this.sendImpl(m);
  }
  onMessage(h: (m: JsonRpcMessage) => void): void {
    this.#onMessage = h;
  }
  onClose(h: (err?: Error) => void): void {
    this.#onClose = h;
  }
  deliver(m: JsonRpcMessage): void {
    this.#onMessage?.(m);
  }
  drop(err?: Error): void {
    this.#onClose?.(err);
  }
}

describe('JSON-RPC 2.0 core (MC-01)', () => {
  it('correlates a response to its request by id', async () => {
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch);
    const promise = peer.request('add', { a: 1 });
    const req = ch.sent[0];
    expect(req).toMatchObject({ jsonrpc: JSONRPC_VERSION, method: 'add', id: 1 });
    ch.deliver({ jsonrpc: JSONRPC_VERSION, id: 1, result: 3 });
    await expect(promise).resolves.toBe(3);
    expect(peer.pendingCount).toBe(0);
  });

  it('does not resolve a request from a mismatched id', async () => {
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch);
    const promise = peer.request('x');
    ch.deliver({ jsonrpc: JSONRPC_VERSION, id: 999, result: 'wrong' });
    // The unknown-id response is dropped; the request is still pending.
    expect(peer.pendingCount).toBe(1);
    ch.deliver({ jsonrpc: JSONRPC_VERSION, id: 1, result: 'right' });
    await expect(promise).resolves.toBe('right');
  });

  it('rejects with a typed JsonRpcCallError for an error response', async () => {
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch);
    const promise = peer.request('boom');
    ch.deliver({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      error: { code: -32601, message: 'no method', data: { x: 1 } },
    });
    await expect(promise).rejects.toBeInstanceOf(JsonRpcCallError);
    await promise.catch((err: JsonRpcCallError) => {
      expect(err.code).toBe(-32601);
      expect(err.data).toEqual({ x: 1 });
    });
  });

  it('sends a notification with no id and dispatches an incoming one', async () => {
    const ch = new FakeChannel();
    const received: Array<[string, unknown]> = [];
    const peer = new JsonRpcPeer(ch, { onNotification: (m, p) => received.push([m, p]) });
    await peer.notify('ping', { n: 1 });
    expect(ch.sent[0]).toEqual({ jsonrpc: JSONRPC_VERSION, method: 'ping', params: { n: 1 } });
    expect('id' in (ch.sent[0] as object)).toBe(false);
    ch.deliver({ jsonrpc: JSONRPC_VERSION, method: 'event', params: 'hi' });
    expect(received).toEqual([['event', 'hi']]);
  });

  it('handles a batch of responses in order', async () => {
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch);
    const a = peer.request('a');
    const b = peer.request('b');
    ch.deliver([
      { jsonrpc: JSONRPC_VERSION, id: 2, result: 'B' },
      { jsonrpc: JSONRPC_VERSION, id: 1, result: 'A' },
    ]);
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('answers an incoming server request through the handler', async () => {
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch, {
      onRequest: (method) => Promise.resolve(`handled:${method}`),
    });
    ch.deliver({ jsonrpc: JSONRPC_VERSION, id: 'srv-1', method: 'elicit', params: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(ch.sent.at(-1)).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 'srv-1',
      result: 'handled:elicit',
    });
    expect(peer.pendingCount).toBe(0);
  });

  it('times out a request that never answers', async () => {
    vi.useFakeTimers();
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch);
    const promise = peer.request('slow', undefined, { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toMatchObject({ class: 'timeout' });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects every in-flight request when the channel closes', async () => {
    const ch = new FakeChannel();
    const peer = new JsonRpcPeer(ch);
    const promise = peer.request('inflight');
    ch.drop(new Error('socket gone'));
    await expect(promise).rejects.toThrow('socket gone');
  });

  it('classifies messages and rejects a malformed frame', () => {
    expect(isRequest(decodeMessage({ jsonrpc: '2.0', id: 1, method: 'm' }) as never)).toBe(true);
    expect(isNotification(decodeMessage({ jsonrpc: '2.0', method: 'm' }) as never)).toBe(true);
    expect(isResponse(decodeMessage({ jsonrpc: '2.0', id: 1, result: 1 }) as never)).toBe(true);
    expect(() =>
      decodeMessage({ jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'x' } }),
    ).toThrow();
    expect(() => decodeMessage(42)).toThrow(McpError);
    expect(() => decodeMessage([])).toThrow(McpError);
  });
});
