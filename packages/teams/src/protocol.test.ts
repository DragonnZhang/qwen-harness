import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ProtocolTracker, type ProtocolMessage, type ProtocolMessageType } from './index.ts';

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

// ---------------------------------------------------------------------------
// AG-08 property: over randomized sequences of registrations and responses
// (valid AND forged), the tracker accepts EXACTLY the correctly-correlated
// responses — right id, right type, and the responder answering the asker.
// ---------------------------------------------------------------------------

const MEMBERS = ['mem_alfa', 'mem_bravo', 'mem_charlie', 'mem_delta'] as const;

type RequestKind =
  | 'permission-request'
  | 'plan-approval-request'
  | 'sandbox-permission-request'
  | 'shutdown-request';

const REQUEST_KINDS: readonly RequestKind[] = [
  'permission-request',
  'plan-approval-request',
  'sandbox-permission-request',
  'shutdown-request',
];

/** Every response type the FSM knows; used to synthesize wrong-type forgeries. */
const RESPONSE_KINDS: readonly ProtocolMessageType[] = [
  'permission-response',
  'plan-approval-response',
  'sandbox-permission-response',
  'shutdown-approved',
  'shutdown-rejected',
];

function buildRequest(kind: RequestKind, correlationId: string): ProtocolMessage {
  switch (kind) {
    case 'permission-request':
      return { type: 'permission-request', correlationId, action: 'x' };
    case 'plan-approval-request':
      return { type: 'plan-approval-request', correlationId, plan: 'p' };
    case 'sandbox-permission-request':
      return { type: 'sandbox-permission-request', correlationId, capability: 'net' };
    case 'shutdown-request':
      return { type: 'shutdown-request', correlationId };
  }
}

function buildResponse(kind: ProtocolMessageType, correlationId: string): ProtocolMessage {
  switch (kind) {
    case 'permission-response':
      return { type: 'permission-response', correlationId, granted: true };
    case 'plan-approval-response':
      return { type: 'plan-approval-response', correlationId, approved: true, feedback: null };
    case 'sandbox-permission-response':
      return { type: 'sandbox-permission-response', correlationId, granted: true };
    case 'shutdown-approved':
      return { type: 'shutdown-approved', correlationId };
    case 'shutdown-rejected':
      return { type: 'shutdown-rejected', correlationId, reason: 'busy' };
    default:
      throw new Error(`not a synthesizable response: ${kind}`);
  }
}

/** The single correct response kind for a request (shutdown resolves to `approved`, one valid choice). */
function correctResponseKind(kind: RequestKind): ProtocolMessageType {
  switch (kind) {
    case 'permission-request':
      return 'permission-response';
    case 'plan-approval-request':
      return 'plan-approval-response';
    case 'sandbox-permission-request':
      return 'sandbox-permission-response';
    case 'shutdown-request':
      return 'shutdown-approved';
  }
}

interface Registration {
  readonly correlationId: string;
  readonly kind: RequestKind;
  readonly asker: string;
  readonly responder: string;
}

type ForgeKind = 'valid' | 'wrongId' | 'wrongMember' | 'wrongType';

describe('ProtocolTracker correlation FSM (AG-08, property)', () => {
  it('accepts exactly the correctly-correlated responses across random valid/forged sequences', () => {
    // A distinct-member pair, so a wrong-member forgery is always genuinely wrong.
    const memberPair = fc
      .tuple(fc.nat(MEMBERS.length - 1), fc.nat(MEMBERS.length - 2))
      .map(([a, b]) => {
        const asker = MEMBERS[a] as string;
        const rest = MEMBERS.filter((m) => m !== asker);
        return { asker, responder: rest[b % rest.length] as string };
      });

    const registration = fc
      .record({
        kind: fc.constantFrom(...REQUEST_KINDS),
        pair: memberPair,
      })
      .map(({ kind, pair }) => ({ kind, asker: pair.asker, responder: pair.responder }));

    // A command references a registration by index and picks how (if at all) to forge the response.
    const command = fc.record({
      index: fc.nat(),
      forge: fc.constantFrom<ForgeKind>('valid', 'wrongId', 'wrongMember', 'wrongType'),
      // Which wrong response type to use for a `wrongType` forgery.
      wrongTypePick: fc.nat(),
      // For shutdown, exercise both approved and rejected as valid answers.
      shutdownRejected: fc.boolean(),
    });

    fc.assert(
      fc.property(
        fc.array(registration, { minLength: 1, maxLength: 12 }),
        fc.array(command, { minLength: 1, maxLength: 40 }),
        (regs, commands) => {
          const tracker = new ProtocolTracker();
          // Independent reference model of what is still outstanding.
          const outstanding = new Map<string, Registration>();

          regs.forEach((r, i) => {
            const correlationId = `c${i}`;
            const reg: Registration = { correlationId, ...r };
            tracker.register(buildRequest(r.kind, correlationId), r.asker, r.responder);
            outstanding.set(correlationId, reg);
          });

          expect(tracker.pendingCount).toBe(outstanding.size);

          for (const cmd of commands) {
            const reg = regs[cmd.index % regs.length] as (typeof regs)[number];
            const idx = cmd.index % regs.length;
            const correlationId = `c${idx}`;
            const stillOutstanding = outstanding.get(correlationId);

            let response: ProtocolMessage;
            let from: string;
            let to: string;
            let expectAccept: boolean;

            const validKind =
              reg.kind === 'shutdown-request' && cmd.shutdownRejected
                ? 'shutdown-rejected'
                : correctResponseKind(reg.kind);

            switch (cmd.forge) {
              case 'valid': {
                response = buildResponse(validKind, correlationId);
                from = reg.responder;
                to = reg.asker;
                // Accepted iff this correlation is still outstanding (a duplicate second valid is not).
                expectAccept = stillOutstanding !== undefined;
                break;
              }
              case 'wrongId': {
                response = buildResponse(validKind, `ghost_${correlationId}`);
                from = reg.responder;
                to = reg.asker;
                expectAccept = false; // no registration under a ghost id
                break;
              }
              case 'wrongMember': {
                response = buildResponse(validKind, correlationId);
                // Reverse the correct direction: the asker tries to answer itself.
                from = reg.asker;
                to = reg.responder;
                expectAccept = false;
                break;
              }
              case 'wrongType': {
                // Any response kind that does NOT correctly answer this request.
                const wrongCandidates = RESPONSE_KINDS.filter((k) => {
                  if (reg.kind === 'shutdown-request')
                    return k !== 'shutdown-approved' && k !== 'shutdown-rejected';
                  return k !== correctResponseKind(reg.kind);
                });
                const pick = wrongCandidates[cmd.wrongTypePick % wrongCandidates.length];
                response = buildResponse(pick as ProtocolMessageType, correlationId);
                from = reg.responder;
                to = reg.asker;
                expectAccept = false;
                break;
              }
            }

            const result = tracker.matchResponse(response, from, to);
            expect(result.ok).toBe(expectAccept);
            if (expectAccept) outstanding.delete(correlationId);
          }

          // Conservation: pending equals exactly the requests never correctly answered.
          expect(tracker.pendingCount).toBe(outstanding.size);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
