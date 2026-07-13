/**
 * @qwen-harness/teams
 *
 * Long-lived agent teams (section F). A team has a lead, independent teammate loops, a shared task
 * graph, and concurrent inboxes. Teammates coordinate through a TYPED protocol, not free-form chat.
 *
 * The invariants that make a team correct:
 *  - a protocol response must match an OUTSTANDING request by correlation id, type, and
 *    sender/recipient — no forged approvals (AG-08);
 *  - inbox delivery is atomic, ordered, and idempotent, and wakes a sleeping teammate (AG-06);
 *  - the autonomous loop handles shutdown FIRST, then messages, then atomically claims one
 *    pending/unowned/unblocked task — two teammates cannot both win one task (AG-11);
 *  - a lost process incarnation becomes `lost`, never `running`; its tasks are released and
 *    requeued after the lease, never double-run; resume spawns a new incarnation under the same
 *    logical member id (AG-12/AG-13).
 */

export { ProtocolTracker, ProtocolMessageSchema, MEMBER_ID } from './protocol.ts';
export type { ProtocolMessage, ProtocolMessageType } from './protocol.ts';
export { Inbox } from './inbox.ts';
export type { InboxEntry } from './inbox.ts';
export { Teammate } from './teammate.ts';
export type { TeammateContext, TeammatePhase, LoopStep } from './teammate.ts';
export { TeamRecovery, DEFAULT_HEARTBEAT } from './recovery.ts';
export type { MemberIncarnation, IncarnationState, HeartbeatOptions } from './recovery.ts';
