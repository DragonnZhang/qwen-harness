import { describe, expect, it } from 'vitest';

import { BACKGROUND_CATEGORIES, classifyForeground, isBackgroundCategory } from './category.ts';

describe('background categories (BG-03)', () => {
  it('models exactly the three categories whose owners exist today', () => {
    expect([...BACKGROUND_CATEGORIES]).toEqual([
      'local-shell',
      'local-workflow',
      'dream-consolidation',
    ]);
    expect(isBackgroundCategory('local-shell')).toBe(true);
    expect(isBackgroundCategory('remote-agent')).toBe(false);
  });
});

describe('classifyForeground (BG-01)', () => {
  it('lets an explicit choice win over any hint', () => {
    expect(classifyForeground({ explicit: 'background', hint: { interactive: true } })).toBe(
      'background',
    );
    expect(classifyForeground({ explicit: 'foreground', hint: { longLived: true } })).toBe(
      'foreground',
    );
  });

  it('falls back conservatively to foreground when nothing is stated', () => {
    expect(classifyForeground({})).toBe('foreground');
    expect(classifyForeground({ hint: { interactive: true } })).toBe('foreground');
  });

  it('backgrounds only clearly long-lived, non-interactive work', () => {
    expect(classifyForeground({ hint: { longLived: true } })).toBe('background');
    expect(classifyForeground({ hint: { longLived: true, interactive: true } })).toBe('foreground');
  });
});
