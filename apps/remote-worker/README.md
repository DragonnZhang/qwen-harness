# @qwen-harness/remote-worker

The authenticated reference peer for remote agents and routines (defaults.md, BG-03/CR-06). A remote
worker is a **real second process**, not an in-memory fake, that speaks a typed, versioned, sequenced
envelope protocol over a bidirectional transport (TLS WebSocket in production).

## The reliability core

Every message carries a **monotonic sequence**. A dropped connection resumes from the last
**acknowledged** sequence and replays only what the other side never confirmed — work is never lost
and never blindly replayed. Verified: after a drop where the peer acked up to sequence 1, only
sequence 2 is replayed.

- **Idempotent** by message id — a duplicate envelope (a retry, a reconnect replay) has no second
  effect.
- **Heartbeat** every 15s; the peer is marked `disconnected` after 45s. On disconnect, in-flight
  work becomes `unknown` — the caller must not replay it; it resumes or expires.
- **Authority** — remote work runs under the intersection of its creation-time ceiling and current
  managed policy (carried as a digest in every envelope). The worker enforces its own sandbox and
  may request *narrower* approval, never broaden authority.

## Scope

This is the protocol + session reliability core, tested deterministically with an injected clock.
The production transport (TLS WebSocket, the short-lived audience-bound worker token, mTLS) and the
two-process loopback acceptance fixture are the remaining checkpoint-07/10 work; the envelope and
resume semantics they carry are built and proven here.
