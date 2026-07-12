# @qwen-harness/policy

The deny-by-default permission engine. **Layer 1, and PURE** — no filesystem, process, network,
clock, RNG, or environment access. `pnpm architecture` fails the build if that ever stops being
true.

## Contract

```ts
policyEngine.evaluate(action: NormalizedAction, ctx: PolicyContext): PolicyDecision
```

- **`NormalizedAction`** — a canonical, fully-specified description of ONE side effect: kind
  (`file-read` | `file-write` | `file-edit` | `patch` | `shell` | `git-read` | `git-write` |
  `network` | `mcp`), canonical absolute paths, argv, network target, content digests.
  `actionDigest(action)` is its stable identity; an approval binds to THIS, never to a tool name.
- **`PolicyDecision`** — `allow` | `deny` | `ask` | `passthrough`, plus a `reason`, a `source`
  (which stage and rule won), and a full `trace` so `doctor` can explain every decision (PS-07).
- **`PolicyContext`** — `{ profile, managedPolicy, rules, grants, workspaceRoot, homeDir, now,
  actor, hookOutcome }`. Every input is explicit; there is no ambient state.

Also exported: `intersect()` / `authorityViolations()` / `isAtMost()` (authority intersection for
children, teams, background, Cron), `validateRuleGrant()`, `classifyPath()`, and the frozen
`PROTECTED_PATH_RULES` / `RECOMMENDED_MANAGED_POLICY`.

## The evaluation pipeline (order is the security property)

```
0 input validation   a non-canonical action is DENIED, never asked about
1 profile            what the profile makes available at all
2 protected paths    can SEAL a verdict against later loosening
3 rules              deny-first merge; repository-scoped rules may never ALLOW
4 grants             an exact digest-bound approval can turn ask -> allow
5 hooks              a hook may RESTRICT; a hook allow is recorded and ignored
6 managed policy     the immutable ceiling, intersected LAST — nothing runs after it
7 user passthrough   a direct `!command` skips the model-approval gate, nothing else
```

Two internal flags carry the invariants:

- **`sealed`** — no later stage may loosen this verdict. Set by `plan` (mutations are UNAVAILABLE,
  not askable) and by protected paths. This is why `plan` cannot be smuggled through shell, a hook,
  MCP, a subagent, a rule, or a grant: there is no code path from a sealed deny back to an allow.
- **`exactGrantOnly`** — only a digest-bound grant (a human approving THIS exact action) may loosen
  it. A broad allow-rule or a narrow rule-grant cannot reach a protected path.

## Non-obvious decisions

### Why policy is pure

A permission decision that can read the world is one that two callers can compute differently — and
the gap between "the sandbox canonicalized this path" and "policy canonicalized this path" is a
TOCTOU window. Policy receives an ALREADY-canonical `NormalizedAction`, PROVES it is canonical
(`checkCanonicalAction`), and decides. If the input is not canonical it is denied — never asked
about, because a malformed path is a bug or an attack and neither should be resolvable by clicking
"yes". The host I/O that produces a canonical path lives in `sandbox-linux`, next to the sandbox, so
there is exactly one canonicalizer.

### Why the managed ceiling is intersected LAST

Managed hard deny must dominate every profile, rule, grant, and hook — including `yolo`. Making it
the final stage turns that into a structural fact of the evaluator rather than a rule each call site
must remember: nothing runs after the intersection, so nothing downstream can loosen it. A managed
policy can only ever REMOVE authority; there is no managed `allow`, because a ceiling that could
raise a floor is where this class of bypass begins.

### Why repository content cannot add authority

A `project`-scoped rule lives in the repository and is attacker-controlled in the malicious-repo
threat model. Project rules may `deny` or `ask`; only scopes a human authored outside the repository
(`user`, `local`, `session`) may `allow`. This is enforced once, in `mergeRules`, not trusted to
every consumer. Security decisions merge DENY-FIRST across scopes — a user `allow` can never
overwrite a project `deny`.

### The protected-path workspace carve-out

Only the `system-path` class (`/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/root`) is exempt inside
the workspace root. Opening a workspace is a deliberate act, and a repository legitimately lives at
`/root/qwen-harness` on the target host; without the carve-out every ordinary edit there would
prompt as a protected `/root` write and train users to click through prompts. The carve-out is
narrow: a `.env`, a `*.pem`, a `.git/**` write, or a `~/.ssh` file inside the workspace stays
protected. Credential classes are protected for READS too — exfiltration is the threat.

## Tests

`src/**/*.test.ts`: the all-mode action matrix (4 profiles × every action kind), managed-deny
dominance, `plan` unavailability (including via shell/hook/MCP/rule/grant), `auto-accept-edits`
boundaries, the full protected-path table, exact-parameter grant binding (property test), and
authority intersection (property test).
