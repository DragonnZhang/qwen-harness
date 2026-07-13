/**
 * @qwen-harness/remote-worker
 *
 * The authenticated reference peer for remote agents and routines (defaults.md, BG-03/CR-06). A
 * remote worker is a REAL second process that speaks a typed, versioned, SEQUENCED envelope
 * protocol over a bidirectional transport (TLS WebSocket in production).
 *
 * The reliability core: every message carries a monotonic sequence, so a dropped connection resumes
 * from the last ACKNOWLEDGED sequence — work is never lost and never blindly replayed. Message ids
 * are idempotent (a duplicate has no second effect); on disconnect, in-flight work becomes `unknown`
 * rather than being replayed; and remote work runs under the intersection of its creation-time
 * ceiling and current managed policy — the worker may request narrower approval, never broaden it.
 */

export {
  EnvelopeSchema,
  REMOTE_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  DISCONNECT_AFTER_MS,
} from './envelope.ts';
export type { Envelope, RemotePayload, RemoteMessageType } from './envelope.ts';
export { RemoteSession } from './session.ts';
export type { PeerState, RemoteSessionOptions } from './session.ts';
