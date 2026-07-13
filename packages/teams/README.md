# @qwen-harness/teams

Long-lived agent teams (section F). A team has a lead, independent teammate loops, a shared task
graph, and concurrent inboxes. Teammates coordinate through a **typed protocol**, not free-form chat.

## The invariants that make a team correct

- **No forged approvals (AG-08).** A protocol response is accepted only if it matches an
  *outstanding* request by correlation id, response type, and sender/recipient — you answer the
  member who asked you, about the thing they asked. A `permission-response` cannot answer a
  `plan-approval-request`; a third member cannot answer a request addressed to someone else.
- **Atomic, ordered, idempotent inbox (AG-06).** Delivering the same message id twice is a no-op;
  messages are read in order; a delivery wakes a sleeping teammate without busy-waiting.
- **Autonomous loop (AG-11).** Each iteration handles **shutdown first** (a team can always be
  stopped), then drains the inbox, then atomically **claims** one pending/unowned/unblocked task.
  Two teammates racing for one task cannot both win — the claim re-reads ownership inside the task
  graph's transaction. Verified by a real two-teammate race.
- **Recovery (AG-12/AG-13).** A lost process incarnation becomes `lost`, never `running`. Its
  in-flight tasks are **released and requeued** after the lease, never double-run. Resume spawns a
  **new incarnation under the same logical member id**; a heartbeat or message from the old
  incarnation is rejected.

The model turn a teammate runs is injected, so the loop and recovery are tested deterministically
against a real `TaskGraph` — the atomic-claim guarantee is only real over real storage.
