# @qwen-harness/testkit

Deterministic fakes: `ManualClock`, `SequentialIds`, canonical actors, and disposable Git fixture
repositories.

**Test-only.** Every package gets this as a `devDependency`; `pnpm architecture` fails the build if
any `src/` file imports it, which is what keeps test scaffolding out of the shipped product.

## Rule

Nothing here bypasses production validation, policy, or storage. A fake provider still emits real
normalized events through the real schema; a fake tool still goes through the real policy
pipeline. A fixture that dodges the production path proves nothing
(`docs/execution/implementation-protocol.md` §7).

`FixtureRepo` builds a real Git repository on real disk under a temp dir, because integration
evidence (class `I`) must use real local dependencies and processes. It disables `core.hooksPath`
by default so a fixture can never silently execute a Git hook — hooks are a documented attack
surface and a test must opt into them explicitly.
