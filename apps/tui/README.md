# @qwen-harness/tui

The interactive terminal UI (Ink 7 + React 19). It is a **view**, not a runtime: it receives items
on an injected `RuntimeSource` port and renders them. It owns no storage, no policy, and no model.

## The trust boundary is in the type system

Every component renders content through `tui-kit`, which accepts only `SafeText` — a nominal type
obtainable *only* from the protocol sanitizer. Model output, tool output, MCP text, and repository
content are all `UntrustedText` until they cross it. Terminal control sequences are emitted solely
by trusted chrome (labels, borders, the yolo banner), never by content.

A hostile tool result containing `ESC[31m` therefore renders as the literal text `RED`, not as a
red-coloured escape. That is asserted, not assumed (`test/unit`).

## Layout

- `Transcript` — completed rows go through Ink `<Static>` (immutable scrollback, written once);
  only the in-flight row lives in the re-rendered live region. This is what keeps a 10,000-row
  transcript cheap.
- `Editor` — the input state machine. Ctrl-C is contextual: while busy it *interrupts*; while idle
  it clears a non-empty buffer, and only a second press on an empty buffer exits.
- `StatusLine` — cwd, model, permission mode, activity. In `yolo` the danger banner is persistent
  and cannot be dismissed.
- `ApprovalDialog` — renders the pending action; an approval resumes the same turn.

## It ships compiled (ADR 0004)

`pnpm build` runs `tsc --build` then bundles `src/bin.tsx` to `dist/tui.bundle.mjs`. Nothing ships a
transpiler. The **PTY gate runs that bundle**, not the sources:

```
pnpm test:pty      # spawns dist/tui.bundle.mjs under a real pseudo-terminal
```

`test/pty/restoration.test.ts` is the UI-13 gate. It proves, on a genuine PTY, that the app renders,
honours a mid-session 80x24 → 120x40 resize, and on SIGINT exits 0 with the cursor restored
(`ESC[?25h`) and no alternate-screen leak (`ESC[?1049h` never sent).

Running the compiled bundle is not a formality: it is how a startup crash was caught that every
component unit test passed straight through.
