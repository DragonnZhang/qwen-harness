# @qwen-harness/daemon

The per-user supervisor daemon (SS-08). It holds the single writer lease for a thread and exposes a
versioned Unix-domain-socket command/event server. The TUI and CLI are clients — they attach, send
typed commands, receive typed events, and can detach and reconnect. Because the daemon owns the
runtime, it outlives any single UI.

## Single-writer lease

Two independent SQLite writers must never interleave a thread's turns. The lease enforces that above
storage: an exclusive lock file (`O_CREAT | O_EXCL`, atomic at the filesystem level) holds the
holder's pid. A second daemon that finds a **live** holder is refused and must attach to it; a lock
from a **crashed** process (its pid is gone) is reclaimed, so a crash never locks a user out forever.
Release only removes the lock if we still hold it — it never clobbers a lease another process took
over.

## Versioned socket protocol

Framing is newline-delimited JSON. The first frame from a client MUST be a `ClientHello` with a
matching protocol version — a mismatch is refused immediately, so a client and daemon of different
builds fail loudly rather than corrupting a thread with a misunderstood command. After the
handshake, clients send commands and the daemon streams events; many clients can watch one thread.

Verified over a real Unix socket: a client handshakes and round-trips a command to an event, and a
version mismatch is rejected. The lease tests prove a second live holder is refused and a stale lock
is reclaimed.

## Scope

This is the supervisor's protocol + lease core. Wiring the socket server to a live `TurnEngine`
(routing `start-turn` into the runtime and streaming its events) reuses the same composition the CLI
already does; that integration and the full detach/reconnect UX are the remaining checkpoint-04 work.
