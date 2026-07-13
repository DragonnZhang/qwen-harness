import {
  EnvelopeSchema,
  DISCONNECT_AFTER_MS,
  type Envelope,
  type RemotePayload,
} from './envelope.ts';

/**
 * The sequenced remote session state machine — the reliability core of the remote peer.
 *
 * It tracks the send/ack sequence and the last acknowledged inbound sequence, so a reconnect can
 * `resume-from-sequence` and replay only what the other side has not confirmed. It dedupes by
 * message id (idempotency), and it decides when a peer is `disconnected` (no heartbeat) and when
 * in-flight work is `unknown` — never immediately replayed.
 */

export type PeerState = 'connecting' | 'connected' | 'disconnected';

export interface RemoteSessionOptions {
  readonly now: () => number;
  readonly authorityCeilingDigest: string;
  readonly disconnectAfterMs?: number;
}

export class RemoteSession {
  #state: PeerState = 'connecting';
  #sendSeq = 0;
  /** The highest inbound sequence we have delivered — our resume point. */
  #lastInboundSeq = -1;
  /** The highest of OUR sequences the peer has acknowledged — their resume point. */
  #lastAckedSeq = -1;
  #lastHeartbeatAt: number;
  readonly #seenMessageIds = new Set<string>();
  readonly #outbound = new Map<number, Envelope>();
  readonly #opts: RemoteSessionOptions;

  constructor(opts: RemoteSessionOptions) {
    this.#opts = opts;
    this.#lastHeartbeatAt = opts.now();
  }

  get state(): PeerState {
    return this.#state;
  }
  get lastInboundSequence(): number {
    return this.#lastInboundSeq;
  }
  get lastAckedSequence(): number {
    return this.#lastAckedSeq;
  }

  markConnected(): void {
    this.#state = 'connected';
    this.#lastHeartbeatAt = this.#opts.now();
  }

  /** Build the next outbound envelope with a fresh monotonic sequence, and remember it for resume. */
  frame(
    payload: RemotePayload,
    ids: { messageId: string; correlationId?: string | null },
  ): Envelope {
    const envelope: Envelope = {
      version: 1,
      messageId: ids.messageId,
      correlationId: ids.correlationId ?? null,
      causationId: null,
      threadId: null,
      turnId: null,
      taskId: null,
      sequence: this.#sendSeq++,
      deadline: null,
      authorityCeilingDigest: this.#opts.authorityCeilingDigest,
      payload,
    };
    this.#outbound.set(envelope.sequence, envelope);
    return envelope;
  }

  /**
   * Accept an inbound envelope. Returns the payload to act on, or null if it was a duplicate (by
   * message id) or a protocol frame handled internally (ack/heartbeat). Idempotency is enforced
   * here: a duplicate envelope has no second effect.
   */
  receive(raw: unknown): { deliver: RemotePayload } | { deliver: null; reason: string } {
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { deliver: null, reason: 'invalid envelope' };
    const env = parsed.data;

    if (this.#seenMessageIds.has(env.messageId)) {
      return { deliver: null, reason: 'duplicate message id (idempotent no-op)' };
    }
    this.#seenMessageIds.add(env.messageId);
    this.#lastHeartbeatAt = this.#opts.now();

    // A heartbeat only refreshes liveness.
    if (env.payload.type === 'heartbeat') {
      if (this.#state === 'disconnected') this.#state = 'connected';
      return { deliver: null, reason: 'heartbeat' };
    }

    // An ack lets us forget outbound frames the peer has confirmed — they need never be replayed.
    if (env.payload.type === 'ack') {
      this.#lastAckedSeq = Math.max(this.#lastAckedSeq, env.payload.ackSequence);
      for (const seq of this.#outbound.keys()) {
        if (seq <= this.#lastAckedSeq) this.#outbound.delete(seq);
      }
      return { deliver: null, reason: 'ack' };
    }

    this.#lastInboundSeq = Math.max(this.#lastInboundSeq, env.sequence);
    return { deliver: env.payload };
  }

  /** The outbound frames not yet acknowledged — what a reconnect replays after resume-from-sequence. */
  unacknowledged(): Envelope[] {
    return [...this.#outbound.values()].sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Mark the peer disconnected if the heartbeat has lapsed. Returns true on a transition. In-flight
   * work is now `unknown` — the caller must NOT replay it; it resumes or expires (defaults.md).
   */
  checkHeartbeat(): boolean {
    if (this.#state === 'disconnected') return false;
    const timeout = this.#opts.disconnectAfterMs ?? DISCONNECT_AFTER_MS;
    if (this.#opts.now() - this.#lastHeartbeatAt > timeout) {
      this.#state = 'disconnected';
      return true;
    }
    return false;
  }
}
