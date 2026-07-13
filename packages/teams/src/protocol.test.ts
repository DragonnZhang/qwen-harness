import { describe, expect, it } from 'vitest';

import { ProtocolTracker, type ProtocolMessage } from './index.ts';

const A = 'mem_lead';
const B = 'mem_worker';

describe('ProtocolTracker (AG-08)', () => {
  it('accepts a response that matches an outstanding request', () => {
    const t = new ProtocolTracker();
    const req: ProtocolMessage = {
      type: 'permission-request',
      correlationId: 'c1',
      action: 'write x',
    };
    t.register(req, B, A); // B asks A
    const res: ProtocolMessage = {
      type: 'permission-response',
      correlationId: 'c1',
      granted: true,
    };
    expect(t.matchResponse(res, A, B)).toEqual({ ok: true }); // A answers B
    expect(t.pendingCount).toBe(0);
  });

  it('rejects a response with no outstanding request (a forged approval)', () => {
    const t = new ProtocolTracker();
    const res: ProtocolMessage = {
      type: 'permission-response',
      correlationId: 'ghost',
      granted: true,
    };
    expect(t.matchResponse(res, A, B).ok).toBe(false);
  });

  it('rejects a response of the WRONG type for the request', () => {
    const t = new ProtocolTracker();
    t.register({ type: 'plan-approval-request', correlationId: 'c2', plan: 'p' }, B, A);
    // A permission-response cannot answer a plan-approval-request.
    const wrong: ProtocolMessage = {
      type: 'permission-response',
      correlationId: 'c2',
      granted: true,
    };
    expect(t.matchResponse(wrong, A, B).ok).toBe(false);
  });

  it('rejects a response from the wrong member', () => {
    const t = new ProtocolTracker();
    t.register({ type: 'permission-request', correlationId: 'c3', action: 'x' }, B, A);
    // A third member C cannot answer a request addressed to A.
    const res: ProtocolMessage = {
      type: 'permission-response',
      correlationId: 'c3',
      granted: true,
    };
    expect(t.matchResponse(res, 'mem_other', B).ok).toBe(false);
  });

  it('accepts EITHER approved or rejected for a shutdown request', () => {
    const t = new ProtocolTracker();
    t.register({ type: 'shutdown-request', correlationId: 's1' }, A, B);
    expect(t.matchResponse({ type: 'shutdown-approved', correlationId: 's1' }, B, A)).toEqual({
      ok: true,
    });

    t.register({ type: 'shutdown-request', correlationId: 's2' }, A, B);
    expect(
      t.matchResponse({ type: 'shutdown-rejected', correlationId: 's2', reason: 'busy' }, B, A),
    ).toEqual({ ok: true });
  });

  it('expires a lost member outstanding requests (AG-13)', () => {
    const t = new ProtocolTracker();
    t.register({ type: 'permission-request', correlationId: 'c4', action: 'x' }, B, A);
    expect(t.pendingCount).toBe(1);
    expect(t.expireFrom(B)).toEqual(['c4']);
    expect(t.pendingCount).toBe(0);
  });
});
