# @qwen-harness/runtime

The headless agent-loop coordinator. Layer 3, and pure of host I/O.

## What it owns, and what it must never do

The runtime owns the turn state machine, budgets, stream normalization, and the loop that ties a
provider to tool execution. It does **not** touch the host: it never spawns a process, reads a
file, invokes Git, or opens a socket. It coordinates the packages that do, through injected
interfaces — and `pnpm architecture` fails the build if that ever stops being true.

That constraint is the point, not a formality. It is what makes the whole product deterministic
under test (RT-08): inject a fake provider, a fake tool executor, a `ManualClock`, and a sequential
ID source, and a complete turn replays identically every run.

## The turn machine

`TurnMachine` is the state machine as an explicit object, checked against the legal-transition
table in `protocol`. An illegal transition **throws** rather than silently corrupting the turn —
a turn that reaches an impossible state is a bug we want to see in a test, not a mystery in
production. A terminal state accepts no further transitions, which is what makes a terminal outcome
trustworthy. `awaiting-approval → executing` is legal (an approval resumes the same turn); there is
no transition that ends a turn merely because an approval happened.

## Budgets are pathology detectors, not just counters

A turn always terminates, and always for a **named** reason. `BudgetTracker` distinguishes running
out of model calls from a no-progress loop from an identical-repeated-call loop — because the fix
for each is different, and the user deserves to know *which* happened. Time is injected, so "8
hours elapsed" is testable in microseconds.

## The normalizer

`RoundNormalizer` folds a provider event stream into the outcome the runtime acts on: assistant
text, the reasoning **summary** (never raw chain-of-thought), the complete tool calls paired by
call ID, usage, and the finish reason. For the Chat transport, which gives us no summary, it records
only that reasoning *occurred* — there is no field that could carry reasoning text. Verified against
event sequences shaped exactly like the real captured DashScope fixtures.
