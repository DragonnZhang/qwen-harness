# @qwen-harness/skills

Skill discovery, registry, catalog, and execution semantics — capability-matrix rows **IN-01 … IN-05**.
(Prompt modes, **IN-09**, live in `packages/instructions/src/prompt-modes.ts`; see "Why prompt modes
are not here" below.)

## The posture

> **A skill is untrusted content addressed by name.**

Both halves matter.

**Untrusted.** A `SKILL.md` can arrive in a repository the user merely opened, from an installed
plugin, or over the wire from an MCP server. It is exactly the untrusted-content path
`docs/security/threat-model.md` describes. So its frontmatter crosses a strict zod schema, its body
is `UntrustedText`, and nothing it declares is authority.

**By name.** The registry is the only way to reach a skill. There is deliberately no
`loadFrom(path)`, no `loadPath`, no overload of `load` that accepts a path — because the moment such
a method exists, a model that can be talked into emitting a path can read any file the process can.
A resource inside a skill is reached as `(name, relative path)` and re-validated against the
canonical root.

## The security model

### 1. Two-level loading (IN-01)

| Level | What is read | When |
|---|---|---|
| Catalog | frontmatter only, via a **bounded head read** (8 KiB) | at discovery |
| Body | the whole `SKILL.md` | only on invocation / selection |

The filesystem is a port (`fs.ts`) with `readHead` and `readFile` as *separate* operations, so this
is a testable claim rather than a hopeful one: `src/registry.test.ts` counts the calls and fails if a
body read happens before an invocation. The catalog also contains **no path** — a path in the catalog
would invite exactly the "model supplies a path" pattern IN-02 forbids.

A refused invocation (not user-invocable, no fork depth) never reads the body at all: the permission
plan is computed *before* the load.

### 2. Canonical scope (IN-02)

Every referenced script/asset/reference passes **three independent barriers** (`scope.ts`):

1. **Lexical** — no absolute path, no `~`, no NUL, no `..` segment.
2. **Lexical containment** after `join` + `normalize`.
3. **Realpath containment** — resolve every symlink in the chain and re-check that the *real* path is
   still under the *real* root.

Only barrier 3 survives a symlink, and a symlink is precisely how a hostile repository escapes a
root (`assets/out -> /etc`, or a `SKILL.md` that is a symlink to `/etc/shadow` — where merely reading
the head is already the exfiltration). `test/security/skill-escape.test.ts` builds those symlinks on
a real disk and demands the rejection; string-matching tests would prove nothing.

The skill root itself is `realpath`'d at registration, so a legitimately symlinked skill collection
still works — containment is judged against the real directory.

Declared `resources:` and `hooks:` are validated **at registration**, so a skill that points outside
its root never becomes selectable. The body read re-canonicalizes and re-parses the file (a TOCTOU
guard: the file may have been swapped since the scan; a file that changed its `name` is refused).

An in-memory skill (dynamic / MCP) has **no root at all** and every resource resolution for it is
rejected with `no-root`. A remote server cannot name a local path.

### 3. Sources and precedence (IN-03)

Ten sources; precedence is a **table** (`SOURCE_PRECEDENCE`), asserted as data in
`src/sources.test.ts`. Higher wins:

```
managed 1000 > dynamic 900 > project 800 > additional-directory 700 > user 600
        > conditional 500 > plugin 400 > mcp 300 > legacy-command 200 > bundled 100
```

Derived from the configuration precedence frozen in `docs/product/defaults.md` (session override >
project > user > built-in), with two rules that are security, not taste:

- **Managed is an immutable ceiling.** `outranks(x, 'managed')` is `false` for every `x`. A managed
  skill's name is reserved; a project/plugin/MCP skill of the same name is *shadowed*, and the
  shadowing is reported.
- **A third-party source can never shadow a first-party one.** `plugin` and `mcp` sit below
  `managed`/`project`/`user`/`additional-directory`.

Collisions resolve deterministically (precedence, then a stable tiebreak), and every loser is
reported — a skill that vanishes without a word is indistinguishable from one an attacker suppressed.

Conditional skills: a skill with `paths:` globs is only offered once a matching path has been
touched, mirroring path-scoped instructions.

### 4. Frontmatter (IN-04)

Strict zod schema over a small, explicit YAML subset (no YAML engine: anchors, merge keys, implicit
typing and multi-document support are pure attack surface for a dozen scalar fields). Fields: `name`,
`description`, `condition`, `allowed-tools`, `context`, `model`, `hooks`, `paths`, `resources`,
`user-invocable`, `command`, `argument-hint`.

- **Unknown keys are an error** — a typo the user wants to know about, or a field from a foreign
  format someone hopes we honor. We do not.
- **Failure is a typed `SkillFrontmatterError` naming file and field.** Never a crash, never a
  silently-ignored skill; discovery *collects* errors and returns them.
- **A skill's directory is its identity**: `name` must equal the directory name, so a file dropped
  onto the search path cannot claim to be `deploy-prod`.
- **There is no field through which a skill could grant authority.** No profile, no isolation, no
  network. `allowed-tools` can only *narrow*.

**Argument substitution** (`$ARGUMENTS`, `$1`…`$9`) neutralizes each argument first: newlines and
Unicode line separators collapse to a space, control/bidi/format characters are stripped, length is
capped. An argument therefore cannot open a `---` fence, start a new directive on its own line, or
inject a terminal escape. Substitution is a **single pass**, so an argument containing `$2` cannot
expand another argument.

### 5. Inline vs forked, and the two budgets (IN-05)

| | inline | forked |
|---|---|---|
| context | parent's | fresh |
| result | appended to parent | summary to parent |
| permission | inherited unchanged | `intersect(parent, parent, managed)` |
| tools | parent ∩ declared | parent ∩ declared |
| child depth | unchanged | decremented (0 left ⇒ typed refusal, never a silent downgrade to inline) |

> **effective authority = requested ∩ parent ∩ managed** — never a union.

The policy dimensions go through `@qwen-harness/policy`'s `intersect`, with the parent passed as
*both* the request and the ceiling: there is no field a skill could ask for more with. Tools are
intersected here; a declared tool the parent does not hold is **denied and reported**, never granted.
`assertPlanNeverBroadens()` re-proves it at the boundary, so a future bug becomes a crash instead of
an escalation.

**Budgets are enforced, and truncation is never silent:**

- *Catalog budget* (default 4,000 tokens): entries are admitted in precedence order while they fit;
  the rest are omitted and named in a `skill-catalog-truncated` signal. A flood of plugin skills can
  never evict a managed one.
- *Loaded-content budget* (5,000 tokens per skill, 25,000 total — the values frozen in
  `docs/product/defaults.md`): an over-long body is truncated at a line boundary with a marker the
  model itself sees, plus a `skill-content-truncated` signal; exceeding the session total is a loud
  `SkillBudgetError`. A repeated load is served from cache and charged once, so a model cannot
  exhaust the budget by looping.

## Why prompt modes are not here

A prompt mode (IN-09) is a function from runtime state to **prompt sections** — the thing
`packages/instructions/src/prompt.ts` defines, orders, and caches. Its "prompt delta" is a section,
its "cache behavior" is a section cache key, its "tool availability" is a filter over the tool
section. Putting it in `skills` would force this package to depend on prompt assembly and would let a
skill — untrusted content — reach the machinery that decides what the system prompt says. Modes are
harness configuration; skills are content. They stay apart.

## Layout

```
src/frontmatter.ts   the untrusted-input boundary: YAML subset + strict schema + argument neutralization
src/scope.ts         the three containment barriers (realpath is the one that matters)
src/sources.ts       the precedence table, as data
src/descriptor.ts    validated metadata; the body is deliberately NOT in here
src/catalog.ts       level one + the catalog token budget
src/registry.ts      name-addressed resolution, level-two loading, the loaded-content budget
src/execution.ts     inline vs forked: context/tool/budget/permission/result semantics
src/discovery.ts     the ten sources on disk; bounded head reads; errors are returned, not dropped
src/fs.ts            the ONLY file that opens node:fs (a declared I/O owner in scripts/graph.ts)
```

## Tests

```
pnpm exec vitest run --project unit packages/skills
pnpm exec vitest run --project security packages/skills   # real files, real symlinks
```
