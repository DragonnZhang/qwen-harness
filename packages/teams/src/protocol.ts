import { z } from 'zod';

/**
 * The teammate protocol (AG-07/AG-08).
 *
 * Teammates coordinate through TYPED messages, not free-form chat. Every request carries a
 * correlation id and a finite-state machine: a response must match an OUTSTANDING request by
 * correlation id, type, and sender/recipient — a teammate cannot forge an approval for a request
 * that was never made, or answer on behalf of the wrong member. That matching is the integrity of
 * the whole protocol.
 */

export const MEMBER_ID = z.string().regex(/^mem_[a-z0-9]{4,32}$/);

export const ProtocolMessageSchema = z.discriminatedUnion('type', [
  // Fire-and-forget.
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('mode-set'), mode: z.string() }),
  z.object({ type: z.literal('termination'), reason: z.string() }),
  z.object({ type: z.literal('task-assignment'), taskId: z.number().int().nonnegative() }),
  z.object({ type: z.literal('team-permission-update'), profile: z.string() }),

  // Request/response pairs — each carries a correlation id.
  z.object({
    type: z.literal('permission-request'),
    correlationId: z.string(),
    action: z.string(),
  }),
  z.object({
    type: z.literal('permission-response'),
    correlationId: z.string(),
    granted: z.boolean(),
  }),
  z.object({
    type: z.literal('plan-approval-request'),
    correlationId: z.string(),
    plan: z.string(),
  }),
  z.object({
    type: z.literal('plan-approval-response'),
    correlationId: z.string(),
    approved: z.boolean(),
    feedback: z.string().nullable(),
  }),
  z.object({ type: z.literal('shutdown-request'), correlationId: z.string() }),
  z.object({ type: z.literal('shutdown-approved'), correlationId: z.string() }),
  z.object({ type: z.literal('shutdown-rejected'), correlationId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal('sandbox-permission-request'),
    correlationId: z.string(),
    capability: z.string(),
  }),
  z.object({
    type: z.literal('sandbox-permission-response'),
    correlationId: z.string(),
    granted: z.boolean(),
  }),
]);
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;
export type ProtocolMessageType = ProtocolMessage['type'];

/** Which response type answers which request type. A response of the wrong type is rejected. */
const RESPONSE_FOR: Partial<Record<ProtocolMessageType, ProtocolMessageType>> = {
  'permission-request': 'permission-response',
  'plan-approval-request': 'plan-approval-response',
  'sandbox-permission-request': 'sandbox-permission-response',
  // shutdown-request is answered by EITHER approved or rejected — handled specially below.
};

interface Outstanding {
  readonly correlationId: string;
  readonly requestType: ProtocolMessageType;
  readonly from: string;
  readonly to: string;
}

/**
 * Tracks outstanding requests and validates responses against them (AG-08). A response is accepted
 * only if there is a matching outstanding request whose expected response type it is, and whose
 * sender/recipient are the reverse of the response's — you answer the member who asked you, about
 * the thing they asked.
 */
export class ProtocolTracker {
  readonly #outstanding = new Map<string, Outstanding>();

  register(msg: ProtocolMessage, from: string, to: string): void {
    if ('correlationId' in msg && isRequest(msg.type)) {
      this.#outstanding.set(msg.correlationId, {
        correlationId: msg.correlationId,
        requestType: msg.type,
        from,
        to,
      });
    }
  }

  /** Returns the matched request, or a typed rejection reason. */
  matchResponse(
    msg: ProtocolMessage,
    from: string,
    to: string,
  ): { ok: true } | { ok: false; reason: string } {
    if (!('correlationId' in msg) || !isResponse(msg.type)) {
      return { ok: false, reason: `${msg.type} is not a response` };
    }
    const req = this.#outstanding.get(msg.correlationId);
    if (req === undefined) {
      return { ok: false, reason: `no outstanding request for correlation ${msg.correlationId}` };
    }
    // A shutdown request is answered by approved OR rejected; others by their single response type.
    const expected =
      req.requestType === 'shutdown-request'
        ? msg.type === 'shutdown-approved' || msg.type === 'shutdown-rejected'
        : RESPONSE_FOR[req.requestType] === msg.type;
    if (!expected) {
      return { ok: false, reason: `${msg.type} does not answer a ${req.requestType}` };
    }
    // The responder must be the recipient of the request, answering its sender.
    if (from !== req.to || to !== req.from) {
      return { ok: false, reason: 'response sender/recipient does not match the request' };
    }
    this.#outstanding.delete(msg.correlationId);
    return { ok: true };
  }

  get pendingCount(): number {
    return this.#outstanding.size;
  }

  /** On teammate loss, its outstanding requests expire with a typed failure (AG-13). */
  expireFrom(member: string): string[] {
    const expired: string[] = [];
    for (const [id, req] of this.#outstanding) {
      if (req.from === member || req.to === member) {
        this.#outstanding.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }
}

function isRequest(type: ProtocolMessageType): boolean {
  return type.endsWith('-request');
}
function isResponse(type: ProtocolMessageType): boolean {
  return type.endsWith('-response') || type === 'shutdown-approved' || type === 'shutdown-rejected';
}
