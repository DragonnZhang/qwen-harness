import { describe, expect, it } from 'vitest';

import { PermissionProfileSchema, PROFILE_ALIASES, resolveProfile } from './domain.ts';

/**
 * The four permission profiles and their documented aliases (PS-01, U).
 *
 * The profiles are exactly `plan`, `ask`, `auto-accept-edits`, `yolo`; every documented compatibility
 * alias maps onto one of those four; and anything else resolves to `undefined` — a usage error, never
 * a silent downgrade to a permissive default. (That the CURRENT profile is visible in every client is
 * the T class: the TUI status line renders it and Shift+Tab cycles it live in
 * `apps/tui/test/pty/mode-switch.test.ts`; the four-profile golden path is `evals/e2e/permissions.test.ts`.)
 */

describe('the four permission profiles + documented aliases (PS-01, U)', () => {
  it('the profiles are exactly plan, ask, auto-accept-edits, yolo — in that order of authority', () => {
    expect(PermissionProfileSchema.options).toEqual(['plan', 'ask', 'auto-accept-edits', 'yolo']);
  });

  it('each canonical profile resolves to itself', () => {
    for (const p of PermissionProfileSchema.options) expect(resolveProfile(p)).toBe(p);
  });

  it('every documented alias maps onto a canonical profile, and only onto one', () => {
    expect(resolveProfile('default')).toBe('ask');
    expect(resolveProfile('manual')).toBe('ask');
    expect(resolveProfile('acceptEdits')).toBe('auto-accept-edits');
    expect(resolveProfile('bypassPermissions')).toBe('yolo');
    // Every alias in the table lands on a real profile — no dangling alias.
    for (const target of Object.values(PROFILE_ALIASES)) {
      expect(PermissionProfileSchema.options).toContain(target);
    }
  });

  it('an unknown profile string resolves to undefined — never a silent permissive default', () => {
    for (const bad of ['turbo', 'YOLO', 'auto', '', 'admin']) {
      expect(resolveProfile(bad), `"${bad}" must not resolve`).toBeUndefined();
    }
  });
});
