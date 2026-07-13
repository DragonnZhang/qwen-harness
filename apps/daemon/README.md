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

## The socket drives a real turn

`Daemon.start` takes the lease **before** it opens the event store, so a second daemon fails before
it can touch the database, and then listens. A client sends `create-thread`, learns the new thread id
from the event stream, and sends `start-turn`. The daemon runs the turn on the same
`createHarnessRuntime` composition the CLI uses — the real policy engine, the real sandboxed tool
worker, the real event store — and broadcasts every durable event to every attached client. Commands
are parsed with the protocol's `CommandSchema` before a single field is read: a local socket is still
an untrusted boundary.

- **Approval** — when policy says `ask`, the daemon persists the pause, pushes an `approval-request`
  frame carrying the exact normalized action, and waits. A client answers with `approve`, and the
  **same turn** resumes into `executing`. An approval is never a new user message. If every client
  detaches before answering, the request is *deferred*: the turn stays `awaiting-approval` in the
  durable log and is resumable later. Nothing is ever auto-approved.
- **Cancellation** — `interrupt` aborts the turn's abort tree, which reaches the sandbox and kills the
  in-flight tool's whole **process group**. The turn then *ends*, with an explicit
  `cancelled / user-cancelled` reason. It never merely stops.
- **Observers** — any number of clients may watch one session; exactly one process writes, and the
  lease is what says which.

`src/bin.ts` is the executable. Started against a live lease it exits `3` and names the holder rather
than opening a second writer.
