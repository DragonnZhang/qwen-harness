# The TUI

> **Read this first.** The shipped TUI binary renders a **scripted demo transcript**. It is not
> connected to the model, the runtime, storage, or policy: `apps/tui/src/` imports only
> `@qwen-harness/protocol` and `@qwen-harness/tui-kit`. Submitting text echoes it back into the
> transcript; nothing is sent anywhere. The interactive coding UI is real, tested code that has not
> yet been given a runtime to talk to.
>
> For actual work, use [the CLI](cli.md).

This page documents what the TUI *is*, because the parts that exist are real and worth knowing: the
rendering model, the sanitization boundary, and the keybindings you will meet the moment it is wired.

## Running it

```sh
pnpm --filter @qwen-harness/tui build   # tsc, then esbuild → dist/tui.bundle.mjs
node apps/tui/dist/tui.bundle.mjs
node apps/tui/dist/tui.bundle.mjs --yolo   # the only flag the binary parses
```

`--yolo` sets the displayed mode to `yolo`; without it the mode is `ask`. There is no other flag, no
prompt argument, and no `--help`.

The PTY gate runs the **bundle**, not the sources — that is how a startup crash was caught that every
component unit test passed straight through.

## Layout

Top to bottom:

1. **Transcript (completed rows)** — rendered through Ink's `<Static>`: written once, straight into
   terminal scrollback, never re-rendered. This is what keeps a 10,000-row transcript cheap.
2. **Transcript (the active row)** — the single in-flight row, in the live region.
3. **StatusLine** — `cwd · model · mode · [N ctx] · working…|idle`. Mode is colored: `plan` blue,
   `ask` green, `auto-accept-edits` yellow, `yolo` red.
4. **Editor** or **ApprovalDialog** — mutually exclusive; the editor is inactive while a dialog is up.

Row kinds the transcript can render: `user`, `assistant`, `reasoning-summary`, `tool-call`,
`tool-result`, `diff`, `error`, `usage`, `progress`, `approval`, `compaction`, `user-shell`. A row
previews 12 lines, then `… N more line(s)`.

In `yolo` a persistent red banner is shown and **cannot be dismissed**:

```text
YOLO MODE — prompts disabled, isolation off; every tool runs with full authority
```

## Keybindings

These are the handlers that exist in `apps/tui/src/Editor.tsx`. Ink is started with
`exitOnCtrlC: false`, so the Ctrl-C behavior below is the only Ctrl-C behavior.

### Editor

| Key | Condition | Behavior |
|---|---|---|
| **Ctrl-C** | busy | **interrupts** the work |
| **Ctrl-C** | idle, buffer non-empty | clears the buffer (and arms exit) |
| **Ctrl-C** | idle, buffer empty | first press arms — `Press Ctrl-C again to exit`; second press exits |
| any other key | armed | disarms the exit |
| **Esc** | busy | interrupts |
| **Esc** | idle | **nothing.** Esc does not exit and does not clear. |
| **Enter** | — | submits |
| **Ctrl/Meta/Shift + Enter** | — | inserts a newline |
| **Backspace** / **Delete** | — | delete backwards (there is no forward-delete binding) |
| **←** / **→** | — | move by character |
| **Ctrl/Meta + ←** / **→** | — | move by word |
| **↑** | cursor on the first row | previous history entry |
| **↑** | otherwise | move up a line |
| **↓** | cursor on the last row | next history entry |
| **↓** | otherwise | move down a line |
| printable text | — | inserted literally — a bracketed paste arrives as one chunk, so a pasted newline is a line break and **never** an accidental submit |

Ctrl-C is contextual on purpose: the key you reach for to stop a runaway must not also be the key
that throws away a half-written prompt, and neither should quietly quit the app.

There is **no Tab handler and no Ctrl-D handler**. `tui-kit` implements undo/redo, history search,
cut/copy/paste registers, line-start/line-end motion, and a vim key layer, but the Editor does not
bind them yet.

### Approval dialog

| Key | Behavior |
|---|---|
| **1** | `allow once` |
| **2** | `allow this session` |
| **3** | `deny` |
| **←** / **↑** | move the highlight back (wraps) |
| **→** / **↓** / **Tab** | move the highlight forward (wraps) |
| **Enter** | confirm the highlighted choice |
| **Esc** | **deny** — the safe default, and the footer says so |

The dialog shows the actor, the action (its exact normalized description), the risk level, and the
sandbox. An approval binds to that exact action; see [Permissions](permissions.md#grants-approvals).

Because the shipped binary never supplies an approval, this dialog cannot currently appear.

## The trust boundary is in the type system

This is the part of the TUI most worth understanding, because it is the defence against a hostile
repository or a hostile MCP server owning your terminal.

Every component renders content through `tui-kit`, which accepts only **`SafeText`** — a nominal type
obtainable *only* from the protocol sanitizer. Model output, tool output, MCP text, and repository
content are all `UntrustedText` until they cross it. Terminal control sequences are emitted solely by
**`TrustedChrome`** — a separately-branded type producible only from a string literal in the code.
There is deliberately no path from untrusted content to trusted chrome. No cast can forge either.

The sanitizer is an **allowlist**, not a blocklist. Nothing survives except `\n` and `\t`, which are
content. Everything stripped is replaced by a **visible** `�`, so an attack is apparent rather than
silently swallowed. In order:

1. Whole ESC-introduced sequences first — CSI, OSC (window title, OSC 8 hyperlinks, **OSC 52
   clipboard exfiltration**), DCS/SOS/PM/APC, and two-character escapes — so a payload cannot survive
   as literal text.
2. `\r\n` → `\n`; a lone `\r` becomes `�` (a bare CR rewinds to column 0 and overwrites text you have
   already read).
3. Remaining C0 controls, DEL, and C1 controls.
4. Deceptive Unicode: zero-width characters, **bidi overrides** (Trojan Source), the soft hyphen, LS
   and PS separators, and the BOM.
5. Truncation, when a limit applies, is *announced*: `… [truncated N chars]`.

Links are checked against a scheme allowlist (`http:`, `https:`, `mailto:`). A `javascript:`,
`data:`, or `file:` target renders as plain, non-clickable text.

The result: a hostile tool result containing `ESC[31m` renders as the literal characters, not as a
red escape. That is asserted in tests, not assumed.
