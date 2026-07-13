# @qwen-harness/tui-kit

The renderer-neutral TUI layer: view models and a multiline editor, testable without a terminal.
The Ink components live in `apps/tui`; keeping the view models here (pure, no host I/O) is what lets
them be tested deterministically.

## The SafeText trust boundary

Every text field in a view model is `SafeText` — it has crossed the `UntrustedText` sanitizer with
the right origin. A renderer accepts only `SafeText` for content, so model/tool/repo text can never
carry a terminal escape into the display. Trusted chrome (row labels, borders, the `yolo` banner) is
a **separate** typed value that is never derived from untrusted input. The compiler enforces the
separation.

## Completed vs active rows (UI-01)

`applyItem` builds `TranscriptRow`s. Completed rows are **stable/frozen**; only the active streaming
row updates. A renderer keeps the completed transcript static and re-renders only the active region,
which is what makes a long transcript cheap to display.

## What's here

- **unicode** — grapheme-aware width and slicing: CJK is width 2, an emoji is one grapheme,
  combining characters attach to their base.
- **diff** — parse a unified diff into colorable hunks/lines (the diff text is untrusted → SafeText).
- **markdown** — segment paragraphs / code fences / inline code / links; an *unterminated* code
  fence (mid-stream) renders as an open block without throwing; a `javascript:`/`file:` link is
  shown as plain text, never a clickable link.
- **editor** — a pure state machine: grapheme-aware cursor and word motion, selection, bracketed
  paste (inserted literally), undo/redo, history + reverse search, configurable submit.
- **inspector** — expand/collapse/search over the full transcript.
