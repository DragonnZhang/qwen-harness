/**
 * @qwen-harness/tui
 *
 * The Ink terminal UI (apps/tui). This is a LAYER 4 app and composition root: it may open host I/O
 * (stdin/stdout, signals in {@link ./bin.tsx}), and it depends on packages only — never on another
 * app. It renders the renderer-neutral view models from `@qwen-harness/tui-kit`; all editing and
 * projection logic lives there, behind the `SafeText` / `TrustedChrome` trust boundary.
 *
 * This barrel exports the components and the injected item-source port so they can be embedded and
 * tested. The executable entry point is `./bin.tsx`, shipped compiled as `dist/tui.bundle.mjs`.
 */

export { App } from './App.tsx';
export type { AppProps } from './App.tsx';
export { Transcript } from './Transcript.tsx';
export { StatusLine } from './StatusLine.tsx';
export { ApprovalDialog } from './ApprovalDialog.tsx';
export { Editor } from './Editor.tsx';
export { arraySource, emitterSource } from './source.ts';
export type { RuntimeSource, MutableSource } from './source.ts';
export type { Activity, StatusModel, ApprovalDecision, ApprovalPrompt } from './types.ts';
