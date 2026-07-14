/**
 * UI-06 — the managed CEILING clamps a RUNTIME approval-mode switch, not just the launch profile.
 *
 * The PTY test (`test/pty/mode-switch.test.ts`) proves Shift+Tab cycles the mode on screen. What it
 * cannot prove is that the switch is REAL — that each cycle re-derives authority through the actual
 * `loadRunAuthority` and is bound by a real administrator policy — because the scripted controller
 * has no authority to clamp. This test closes that gap at the controller/authority layer.
 *
 * It builds a genuine LIVE controller (`createLiveTurn`, the same `createHarnessRuntime` path `run`
 * uses) over a temp workspace whose managed policy sets `maxProfile: plan`, then cycles the mode all
 * the way to a REQUESTED `yolo` and asserts the status line's profile stays clamped at `plan`. The
 * clamp is not a UI toggle: `cycleMode` calls `loadRunAuthority` with the temp `managedPath`, and the
 * ceiling in `@qwen-harness/config`/`@qwen-harness/policy` does the clamping. A second controller
 * with NO ceiling proves the switch genuinely CHANGES the effective profile, so the clamp above is a
 * real bound and not a controller that simply never moves.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLiveTurn } from '../../src/live-turn.ts';

let dir: string;
let home: string;
let project: string;
let managedPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-tui-ceiling-'));
  home = join(dir, 'home');
  project = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  managedPath = join(dir, 'managed.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runtime mode switch is bound by the managed ceiling', () => {
  it('a cycle requesting yolo under maxProfile:plan clamps to plan', () => {
    // The administrator pins the ceiling at `plan`. No cycle may exceed it.
    writeFileSync(managedPath, JSON.stringify({ maxProfile: 'plan' }), 'utf8');

    const controller = createLiveTurn({ mode: 'plan', cwd: project, managedPath });

    // Launch: requested plan, clamped plan.
    expect(controller.getView().status.mode).toBe('plan');

    // Cycle plan→ask: the request is `ask`, but the ceiling clamps it back to `plan`.
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('plan');

    // ask→auto-accept-edits: still clamped.
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('plan');

    // auto-accept-edits→yolo: THE security-critical case. A requested yolo on a `maxProfile: plan`
    // host resolves to `plan` — the ceiling wins on a RUNTIME switch exactly as it does at launch.
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('plan');

    // yolo→plan: wraps around, still plan.
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('plan');
  });

  it('with no ceiling, cycling genuinely re-derives and changes the effective profile', () => {
    // maxProfile:yolo means the ceiling never binds, so the effective profile follows the request —
    // proving the clamp in the previous test is a real bound, not a stuck controller.
    writeFileSync(managedPath, JSON.stringify({ maxProfile: 'yolo' }), 'utf8');

    const controller = createLiveTurn({ mode: 'ask', cwd: project, managedPath });
    expect(controller.getView().status.mode).toBe('ask');

    // Cycle order from ask: auto-accept-edits → yolo → plan → ask.
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('auto-accept-edits');
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('yolo');
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('plan');
    controller.cycleMode();
    expect(controller.getView().status.mode).toBe('ask');
  });
});
