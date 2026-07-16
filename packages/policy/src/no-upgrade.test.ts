import { describe, expect, it } from 'vitest';

import { ctx, network } from '../test/helpers.ts';
import { PolicyEngine } from './engine.ts';
import { NO_MANAGED_RESTRICTIONS } from './managed.ts';

/**
 * Repeated denials never upgrade authority, and hard policy bounds every auto-decision (PS-10, U+S).
 *
 * The engine is the classifier: it decides allow/ask/deny for an action. PS-10 requires two things of
 * it — that no amount of REPETITION turns a denial into an allow (there is no denial counter that
 * eventually says "yes"), and that automated classification can only reduce prompts INSIDE hard policy
 * (the managed ceiling is absolute, so the most permissive profile still cannot exceed it).
 */

const engine = new PolicyEngine();
const NO_NETWORK = { ...NO_MANAGED_RESTRICTIONS, networkAllowed: false };

describe('repeated denials are stable — repetition never becomes an allow (PS-10, U)', () => {
  it('evaluating the same denied action twelve times denies every single time', () => {
    const context = ctx({ profile: 'yolo', managedPolicy: NO_NETWORK });
    const outcomes = Array.from({ length: 12 }, () => engine.evaluate(network(), context).outcome);
    expect(outcomes.every((o) => o === 'deny')).toBe(true);
    // The one thing that must NEVER appear: a silent upgrade to allow after being asked repeatedly.
    expect(outcomes).not.toContain('allow');
  });
});

describe('automated classification stays inside hard policy (PS-10, S)', () => {
  it('the managed ceiling denies the network even under the most permissive profile', () => {
    // `yolo` auto-allows almost everything — yet hard policy still forbids the network reach.
    expect(
      engine.evaluate(network(), ctx({ profile: 'yolo', managedPolicy: NO_NETWORK })).outcome,
    ).toBe('deny');
    // Remove ONLY the managed restriction and `yolo` reaches it — proving the deny came from hard
    // policy, not from the action being intrinsically forbidden.
    expect(engine.evaluate(network(), ctx({ profile: 'yolo' })).outcome).not.toBe('deny');
  });
});
