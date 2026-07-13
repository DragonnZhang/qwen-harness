import { z } from 'zod';

/**
 * The remote agent/routine peer protocol (defaults.md "Remote agent and routine peer", BG-03/CR-06).
 *
 * A remote worker is a REAL second process, not an in-memory fake. It speaks this typed, versioned,
 * sequenced envelope protocol over a bidirectional transport (TLS WebSocket in production). The
 * sequencing is the point: every message carries a monotonic sequence, so a dropped connection
 * resumes from the last ACKNOWLEDGED sequence — work is never lost, and never blindly replayed.
 *
 * The safety rules encoded here:
 *   - message IDs and side-effect IDs are idempotent — a duplicate envelope has no second effect;
 *   - on disconnect, in-flight work becomes `unknown`, never immediately replayed;
 *   - remote work receives the intersection of its creation-time ceiling and current managed policy;
 *     the worker enforces its own sandbox and may request NARROWER approval, never broaden authority.
 */

export const REMOTE_PROTOCOL_VERSION = 1;

export const EnvelopeSchema = z.object({
  version: z.number().int().positive(),
  messageId: z.string().min(1).max(128),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  taskId: z.string().nullable(),
  /** Monotonic per connection. The resume point is the last acknowledged sequence. */
  sequence: z.number().int().nonnegative(),
  deadline: z.number().int().nullable(),
  /** A digest of the authority ceiling this work runs under. The worker cannot exceed it. */
  authorityCeilingDigest: z.string(),
  payload: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('hello'),
      workerIdentity: z.string(),
      incarnation: z.string(),
      capabilities: z.array(z.string()),
    }),
    z.object({ type: z.literal('lease-offer'), leaseId: z.string() }),
    z.object({ type: z.literal('lease-accept'), leaseId: z.string() }),
    z.object({ type: z.literal('lease-reject'), leaseId: z.string(), reason: z.string() }),
    z.object({ type: z.literal('input'), text: z.string() }),
    z.object({ type: z.literal('event-batch'), events: z.array(z.unknown()) }),
    z.object({ type: z.literal('ack'), ackSequence: z.number().int().nonnegative() }),
    z.object({
      type: z.literal('approval-request'),
      correlationId: z.string(),
      action: z.string(),
    }),
    z.object({
      type: z.literal('approval-response'),
      correlationId: z.string(),
      granted: z.boolean(),
    }),
    z.object({ type: z.literal('cancel'), correlationId: z.string() }),
    z.object({
      type: z.literal('cancel-ack'),
      correlationId: z.string(),
      state: z.enum(['cancelled', 'unknown']),
    }),
    z.object({ type: z.literal('heartbeat') }),
    z.object({ type: z.literal('result'), summary: z.string() }),
    z.object({ type: z.literal('failure'), category: z.string(), message: z.string() }),
    z.object({
      type: z.literal('resume-from-sequence'),
      fromSequence: z.number().int().nonnegative(),
    }),
  ]),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type RemotePayload = Envelope['payload'];
export type RemoteMessageType = RemotePayload['type'];

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const DISCONNECT_AFTER_MS = 45_000;
