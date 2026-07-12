# @qwen-harness/protocol

Layer 0. Commands, events, items, schemas, versions.

## Contract

**This package opens no host capability.** No filesystem, process, network, database, clock,
random, or environment I/O. `pnpm architecture` fails the build if it does — including a bare
`Date.now()` or `Math.random()`.

That is not fastidiousness. The entire runtime's determinism and replayability (RT-08) rests on
time and identity being _injected_ rather than ambient, so `Clock` and `IdSource` are interfaces
declared here and implemented by layers that are allowed to touch the host.

## What lives here

| Module        | Purpose                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids.ts`      | Branded IDs (`ThreadId`, `TurnId`, …). Branding makes passing a `TurnId` where a `ThreadId` belongs a _type error_, which is the class of bug that silently corrupts an event log. |
| `domain.ts`   | `Thread` → `Turn` → `Item`, permission profiles, the turn state machine, `UntrustedText`/`SafeText`.                                                                               |
| `events.ts`   | The event envelope, side-effect lifecycle, and `parseEventLenient` (forward compatibility).                                                                                        |
| `errors.ts`   | `HarnessError`, typed on five axes: origin, retryability, user action, side-effect certainty, visible output.                                                                      |
| `commands.ts` | The typed command protocol every client speaks.                                                                                                                                    |
| `clock.ts`    | `Clock` interface + `ManualClock`.                                                                                                                                                 |

## Two ideas worth knowing

**Turn state machine.** Transitions are declared as data (`TURN_TRANSITIONS`) so they are testable
as data. Note that `awaiting-approval → executing` is legal and `awaiting-approval → completed` is
not: an approval _resumes the same turn_, it is never a new user message.

**Unknown events survive.** `parseEventLenient` turns a payload this build has never heard of into
an `unknown` payload rather than dropping it, so an older build can read a newer export and
re-export it without destroying data. The envelope, however, is still mandatory — forward
compatibility is not an excuse to accept an unattributable event.
