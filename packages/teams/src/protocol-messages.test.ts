import { describe, expect, it } from 'vitest';

import { ProtocolMessageSchema, type ProtocolMessage } from './protocol.ts';

/**
 * The team protocol MESSAGE SET (AG-07).
 *
 * AG-07 freezes the exact set of messages teammates and the lead exchange. This proves the set is
 * COMPLETE — every required message type parses — and correct: unknown types are rejected, and the
 * request/response pairs carry a correlation id (so `ProtocolTracker`, tested separately for AG-08,
 * can match a response to its request). The correlation-FSM behaviour itself is in `protocol.test.ts`.
 */

/** One valid, minimal message of every required type. */
const SAMPLES: readonly ProtocolMessage[] = [
  { type: 'message', text: 'hello' },
  { type: 'idle' },
  { type: 'mode-set', mode: 'ask' },
  { type: 'termination', reason: 'done' },
  { type: 'task-assignment', taskId: 3 },
  { type: 'team-permission-update', profile: 'ask' },
  { type: 'permission-request', correlationId: 'c1', action: 'run_shell rm' },
  { type: 'permission-response', correlationId: 'c1', granted: false },
  { type: 'plan-approval-request', correlationId: 'c2', plan: 'do the thing' },
  { type: 'plan-approval-response', correlationId: 'c2', approved: true, feedback: null },
  { type: 'shutdown-request', correlationId: 'c3' },
  { type: 'shutdown-approved', correlationId: 'c3' },
  { type: 'shutdown-rejected', correlationId: 'c3', reason: 'still working' },
  { type: 'sandbox-permission-request', correlationId: 'c4', capability: 'network' },
  { type: 'sandbox-permission-response', correlationId: 'c4', granted: true },
];

const REQUIRED_TYPES = [
  'message',
  'idle',
  'mode-set',
  'termination',
  'task-assignment',
  'team-permission-update',
  'permission-request',
  'permission-response',
  'plan-approval-request',
  'plan-approval-response',
  'shutdown-request',
  'shutdown-approved',
  'shutdown-rejected',
  'sandbox-permission-request',
  'sandbox-permission-response',
] as const;

describe('team protocol message set (AG-07)', () => {
  it('every required message type parses as a valid protocol message', () => {
    for (const sample of SAMPLES) {
      expect(ProtocolMessageSchema.parse(sample)).toEqual(sample);
    }
  });

  it('the set is exactly the required types — none missing, none extra', () => {
    expect(new Set(SAMPLES.map((m) => m.type))).toEqual(new Set(REQUIRED_TYPES));
    // The discriminated union has exactly one member per required type.
    expect(ProtocolMessageSchema.options).toHaveLength(REQUIRED_TYPES.length);
  });

  it('rejects an unknown message type and a request missing its correlation id', () => {
    expect(ProtocolMessageSchema.safeParse({ type: 'not-a-message' }).success).toBe(false);
    expect(
      ProtocolMessageSchema.safeParse({ type: 'permission-request', action: 'x' }).success,
    ).toBe(false);
  });

  it('every request/response pair shares a correlation id shape', () => {
    const withCorrelation = SAMPLES.filter((m) => 'correlationId' in m);
    // The six request/response messages plus the three shutdown messages all carry a correlation id.
    expect(withCorrelation.map((m) => m.type)).toEqual([
      'permission-request',
      'permission-response',
      'plan-approval-request',
      'plan-approval-response',
      'shutdown-request',
      'shutdown-approved',
      'shutdown-rejected',
      'sandbox-permission-request',
      'sandbox-permission-response',
    ]);
  });
});
