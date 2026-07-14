/**
 * UI-05 focused tests for the REAL ApprovalDialog.
 *
 * The audit closed T/E for this row via golden-path-8 (the live approval dialog), but the U class
 * (the dialog shows the EXACT normalized action, the risk, the sandbox, and every choice) and the S
 * class (hostile action/parameter text is rendered INERT and can never hide the parameters the
 * decision depends on) had no committed component test. This adds both, rendering the actual
 * `ApprovalDialog` with ink-testing-library exactly as tui.test.ts renders its components.
 *
 * SafeText is nominal: the ONLY way to make one is `sanitize`, which is also the boundary the real
 * callers (live-turn.ts / scripted-turn.ts) cross to build an ApprovalPrompt. Feeding the dialog
 * `sanitize(...).text` is therefore both the type-correct construction AND an end-of-path assertion
 * that the boundary neutralises the attack before the component ever sees the bytes.
 *
 * A `.test.ts` (not `.tsx`), constructed with `React.createElement`, because the `unit` vitest
 * project globs `*.test.ts`.
 */

import { sanitize } from '@qwen-harness/protocol';
import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalDialog } from '../../src/ApprovalDialog.tsx';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// The exact sanitize options the real callers use to mint an ApprovalPrompt.action (live-turn.ts /
// scripted-turn.ts): tool origin, single line, bounded to 200 chars.
const action = (raw) => sanitize(raw, { origin: 'tool', multiline: false, maxLength: 200 });
// The other prompt fields are also SafeText; the callers sanitize them the same way (single line).
const safe = (raw) => sanitize(raw, { origin: 'user', multiline: false }).text;

const rendered = [];
function mount(element) {
  const instance = render(element);
  rendered.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

describe('ApprovalDialog shows the exact decision inputs (UI-05 · U)', () => {
  it('renders the full normalized action, actor, risk, sandbox and every choice', async () => {
    const ACTION = 'shell.exec: rm -rf /var/tmp/build-cache --force --recursive';
    const built = action(ACTION);
    const prompt = {
      actor: safe('model'),
      action: built.text,
      risk: 'high',
      isolation: safe('workspace-write'),
    };
    const { lastFrame } = mount(h(ApprovalDialog, { prompt, onDecision: vi.fn() }));
    await tick();
    const out = lastFrame();

    // The action is short enough to be untouched by the 200-char bound: the WHOLE string is on
    // screen, not truncated away — the row's "shows the exact normalized action" guarantee.
    expect(built.truncated).toBe(false);
    expect(built.modified).toBe(false);
    expect(out).toContain(ACTION);

    // The three other decision inputs the row promises are each present as their own field.
    expect(out).toContain('model'); // actor
    expect(out).toContain('high'); // risk level
    expect(out).toContain('workspace-write'); // isolation / sandbox mode

    // Trusted chrome + field labels the component owns.
    expect(out).toContain('Approval required');
    expect(out).toContain('actor');
    expect(out).toContain('action');
    expect(out).toContain('risk');
    expect(out).toContain('sandbox');

    // Every grant the dialog offers is shown at once — there is no hidden tab.
    expect(out).toContain('allow once');
    expect(out).toContain('allow this session');
    expect(out).toContain('deny');
    expect(out).toContain('Esc denies');
  });

  it('is the real component with real key bindings (1 once, 2 session, 3 deny)', async () => {
    const prompt = {
      actor: safe('model'),
      action: action('read_file /etc/hosts').text,
      risk: 'low',
      isolation: safe('read-only'),
    };

    const once = vi.fn();
    mount(h(ApprovalDialog, { prompt, onDecision: once })).stdin.write('1');
    await tick();
    expect(once).toHaveBeenCalledWith('once');

    const session = vi.fn();
    mount(h(ApprovalDialog, { prompt, onDecision: session })).stdin.write('2');
    await tick();
    expect(session).toHaveBeenCalledWith('session');

    const denied = vi.fn();
    mount(h(ApprovalDialog, { prompt, onDecision: denied })).stdin.write('3');
    await tick();
    expect(denied).toHaveBeenCalledWith('deny');
  });
});

describe('ApprovalDialog renders hostile action/params inert (UI-05 · S)', () => {
  it('neutralises ANSI/OSC/OSC-52/OSC-8 and newline-hiding without dropping the real parameter', async () => {
    // A tool mints a normalized action. This one is hostile: the genuinely dangerous parameter is
    // FIRST (it must stay on screen), then it tries to (a) clear+repaint the screen, (b) exfiltrate
    // via an OSC-52 clipboard write, (c) draw a lying OSC-8 hyperlink, (d) paint a fake green
    // "APPROVED" banner, and (e) shove the tail off-screen with a wall of newlines.
    const REAL_PARAM = 'fs.write /etc/cron.d/backdoor';
    const CLIP = 'ZXhmaWx0cmF0ZWQ='; // base64 clipboard payload
    const LINK = 'evil.example';
    const HOSTILE =
      REAL_PARAM +
      `${ESC}[2J${ESC}[H` + // clear screen + cursor home
      `${ESC}]52;c;${CLIP}${BEL}` + // OSC 52 clipboard exfiltration
      `${ESC}]8;;http://${LINK}/x${BEL}click-here${ESC}]8;;${BEL}` + // OSC 8 lying hyperlink
      `${ESC}[32m APPROVED ${ESC}[0m` + // fake green approval banner
      '\n\n\n\n\n\n\n\n\n\ntail-after-newlines';

    const result = action(HOSTILE);

    // --- Boundary: live-turn.ts / scripted-turn.ts build the prompt exactly this way. ---
    expect(result.modified).toBe(true);
    expect(result.strippedControlSequences).toBeGreaterThan(0);
    // No ESC survives into SafeText, so no escape can reach the frame from the action at all.
    expect(result.text).not.toContain(ESC);
    // The escape PAYLOADS — not just the introducer — are gone: the clipboard blob, the link target,
    // and the CSI/OSC verbs.
    expect(result.text).not.toContain(CLIP);
    expect(result.text).not.toContain(LINK);
    expect(result.text).not.toContain('http://');
    expect(result.text).not.toContain('[2J');
    expect(result.text).not.toContain(']52');
    expect(result.text).not.toContain(']8;');
    // The real parameter survived at the front, the visible link text survived as inert content, and
    // the newlines collapsed to spaces — so nothing the user must see was pushed off-screen.
    expect(result.text).toContain(REAL_PARAM);
    expect(result.text).toContain('click-here');
    expect(result.text).toContain('tail-after-newlines');
    expect(result.text).not.toContain('\n');

    // --- Component: the REAL dialog renders the sanitized action (U/S evidence). ---
    const prompt = {
      actor: safe('model'),
      action: result.text,
      risk: 'low', // green chrome; keeps the frame free of the injected `[31m`/`[32m` we could confuse
      isolation: safe('workspace-write'),
    };
    const { lastFrame } = mount(h(ApprovalDialog, { prompt, onDecision: vi.fn() }));
    await tick();
    const out = lastFrame();

    // The dangerous parameter the user must weigh is on screen — the attack did not hide it.
    expect(out).toContain(REAL_PARAM);
    // Every injected control sequence is inert in the frame: neither the introducer nor its payload
    // survives to drive the terminal.
    expect(out).not.toContain('[2J');
    expect(out).not.toContain(']52');
    expect(out).not.toContain(']8;');
    expect(out).not.toContain(CLIP);
    expect(out).not.toContain(LINK);
    expect(out).not.toContain('http://');
    // The stripped sequences render as a visible placeholder, so the attack is apparent, not eaten.
    expect(out).toContain('�');
  });
});
