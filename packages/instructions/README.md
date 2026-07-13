# @qwen-harness/instructions

Repository instruction resolution and deterministic system-prompt assembly (IN-06, IN-07, IN-08,
IN-10).

A declared I/O owner (`scripts/graph.ts`): `discovery.ts` may read instruction files with
`node:fs`/`node:path`; every other module is pure and testable without a filesystem. Depends on
`protocol` and `config`.

## The one non-negotiable posture

Repository instructions are **untrusted context, never authority**. They resolve into text with
provenance and precedence. There is deliberately no field through which an `AGENTS.md` could set a
permission, empty a deny list, grant a tool, or relax the managed ceiling. A more-specific
instruction wins over a less-specific one **as text**; it can never out-vote policy (SC-02, PS-07).
`INSTRUCTIONS_ARE_CONTEXT_ONLY` is where that promise is written down, and the tests assert a
resolved instruction exposes exactly `{ provenance, content, precedence, pathScope }`.

## Resolution (IN-06)

`loadInstructions({ repoRoot, ... })` discovers instruction files and returns an
`InstructionsLoaded`-shaped result (the payload the `InstructionsLoaded` hook fires with).

Scopes, least-specific to most-specific — the array order **is** the base precedence:

```
global  <  user  <  ancestor  <  repo-root  <  nested (path-scoped)
```

Within one scope a deeper directory (closer to the accessed file) wins; ties break by path so the
result never depends on filesystem iteration order. Every resolved instruction carries
`provenance = { path, scope, dir, depth }`.

Nested instructions are **path-scoped**: they apply only when a path under their directory is
accessed (`applicableInstructions(loaded, accessedPaths)`), matching the post-compaction reattach
rule in `defaults.md`. Prefix matching is by resolved path segments, so `/repo/apps` never matches
`/repo/apps-legacy`.

A missing file contributes nothing (no source, no error). A present file that cannot be read is an
`InstructionReadError` that names the path.

## System prompt as sections (IN-07, IN-08)

The system prompt is not one mutable string — it is a list of `PromptSection`s, each with its own
content and a deterministic cache key derived from the runtime inputs it was built from:

- **stable** sections (`identity`, `tools`, `workspace`) form the cacheable prefix;
- **dynamic** sections (`memory`, `session`, `mcp`, `context`) trail it.

`composeSystemPrompt(sections)` orders stable-before-dynamic (canonically, independent of input
order), returns the assembled `text`, the `stablePrefix`, and a per-section `cacheKeys` map.
`buildStandardSections(state)` builds the seven canonical sections from `SystemPromptState`.

The cache-boundary property is tested directly: changing one dynamic input changes only that
section's key and leaves the stable prefix byte-identical.

## Instructions on every request (IN-10)

`instructionStringForRequest(loaded, opts)` composes the system prompt plus every applicable
repository instruction. `buildRequestInstructions` returns that text with `sent: true`. Cache
optimization may not change behavior: the same text is produced whether or not
`transportInheritsInstructions` is set — the flag is echoed for logging only. `attachInstructions`
fills the `instructions` slot on any request-shaped object (kept generic so this package need not
depend on `provider-core`).

## Tests

- `src/resolution.test.ts` — precedence, provenance, path scoping, context-only posture.
- `src/prompt.test.ts` — deterministic composition and the cache-boundary property.
- `src/request.test.ts` — IN-10 text present and behavior-invariant under the inheritance hint.
- `test/integration/resolution.test.ts` — real temp-dir trees, table-driven precedence, and the
  managed-policy-untouchable property.
