import { describe, expect, it } from 'vitest';

import { TURN_ORDER } from './turn-engine.ts';

/**
 * RT-05 (U): the canonical turn phase order is declared once, as data, in the exact documented
 * sequence. The engine's runtime behavior is proven by the integration/e2e tests; this unit test
 * pins the CONSTANT so the two newly-wired phases keep their canonical positions:
 * `queued-notifications` right after `input-hooks`, and `stop-hooks` last.
 */
describe('TURN_ORDER (RT-05)', () => {
  it('lists exactly the 10 phases in the canonical order', () => {
    expect(TURN_ORDER).toEqual([
      'input-hooks',
      'queued-notifications',
      'context-assembly',
      'model',
      'recovery',
      'permission-hooks',
      'tool-scheduling',
      'post-hooks',
      'results',
      'stop-hooks',
    ]);
  });

  it('has queued-notifications at index 1, immediately after input-hooks', () => {
    expect(TURN_ORDER[0]).toBe('input-hooks');
    expect(TURN_ORDER[1]).toBe('queued-notifications');
    expect(TURN_ORDER.indexOf('queued-notifications')).toBe(1);
  });

  it('ends with stop-hooks', () => {
    expect(TURN_ORDER[TURN_ORDER.length - 1]).toBe('stop-hooks');
  });

  it('has no duplicate phases', () => {
    expect(new Set(TURN_ORDER).size).toBe(TURN_ORDER.length);
  });
});
