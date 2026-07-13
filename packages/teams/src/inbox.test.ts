import { describe, expect, it } from 'vitest';

import { Inbox, type ProtocolMessage } from './index.ts';

const MSG: ProtocolMessage = { type: 'message', text: 'hi' };

describe('Inbox (AG-06)', () => {
  it('delivers in order', () => {
    const inbox = new Inbox();
    inbox.deliver('m1', 'a', { type: 'message', text: 'one' }, 1);
    inbox.deliver('m2', 'a', { type: 'message', text: 'two' }, 2);
    const drained = inbox.drain();
    expect(drained.map((e) => e.seq)).toEqual([0, 1]);
    expect(drained.map((e) => (e.message.type === 'message' ? e.message.text : ''))).toEqual([
      'one',
      'two',
    ]);
  });

  it('is idempotent by id — a duplicate is dropped', () => {
    const inbox = new Inbox();
    expect(inbox.deliver('m1', 'a', MSG, 1)).toBe(true);
    expect(inbox.deliver('m1', 'a', MSG, 2)).toBe(false); // duplicate
    expect(inbox.pending).toBe(1);
  });

  it('wakes a sleeping reader when a message arrives', async () => {
    const inbox = new Inbox();
    const wait = inbox.waitForMessage();
    let woke = false;
    void wait.then(() => {
      woke = true;
    });
    expect(woke).toBe(false);
    inbox.deliver('m1', 'a', MSG, 1);
    await wait;
    expect(woke).toBe(true);
  });

  it('resolves immediately if a message is already pending', async () => {
    const inbox = new Inbox();
    inbox.deliver('m1', 'a', MSG, 1);
    await expect(inbox.waitForMessage()).resolves.toBeUndefined();
  });
});
