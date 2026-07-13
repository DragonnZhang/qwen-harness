/**
 * Shared prop shapes for the Ink components (apps/tui).
 *
 * The trust boundary from `tui-kit` continues here: every field that carries model/tool/repo/user
 * text is `SafeText` (it has crossed `sanitize`), while framing — labels, banners, the mode name —
 * is trusted chrome the components own. A component NEVER styles the terminal from a `SafeText`
 * value; it only ever renders it as inert content.
 */

import type { PermissionProfile, SafeText } from '@qwen-harness/protocol';

/** Whether a turn is actively running. Drives the status indicator and Ctrl-C semantics (UI-07). */
export type Activity = 'idle' | 'busy';

/** What the status line shows (UI-06, UI-12). `mode` is the live permission profile. */
export interface StatusModel {
  readonly cwd: SafeText;
  readonly model: SafeText;
  readonly mode: PermissionProfile;
  readonly activity: Activity;
  readonly contextTokens: number | null;
}

/** The three permission grants an approval dialog offers, plus deny (UI-05). */
export type ApprovalDecision = 'once' | 'session' | 'deny';

/**
 * A pending approval to render (UI-05). `actor` and `action` are untrusted (a tool minted the
 * normalized action; a subagent minted its label), so they are `SafeText`. `risk`/`isolation` are
 * our own classification and the current sandbox mode.
 */
export interface ApprovalPrompt {
  readonly actor: SafeText;
  readonly action: SafeText;
  readonly risk: 'low' | 'medium' | 'high';
  readonly isolation: SafeText;
}
