import { describe, expect, it } from 'vitest';

import { CronError, matches, nextFireAfter, parseCron, type CronErrorCode } from './cron.ts';

/**
 * The cron parser and matcher as evidence (CR-01). Dates are constructed from LOCAL components and
 * asserted against local-time matching, so these hold regardless of the host timezone.
 */
describe('parseCron field forms (CR-01)', () => {
  it('parses a wildcard into the full range', () => {
    const c = parseCron('* * * * *');
    expect(c.minute.size).toBe(60);
    expect(c.hour.size).toBe(24);
    expect([...c.month].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(c.domRestricted).toBe(false);
    expect(c.dowRestricted).toBe(false);
  });

  it.each([
    { field: '*/15', expected: [0, 15, 30, 45] },
    { field: '5/20', expected: [5, 25, 45] },
    { field: '0-10', expected: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { field: '0-20/5', expected: [0, 5, 10, 15, 20] },
    { field: '1,2,7,30', expected: [1, 2, 7, 30] },
    { field: '0-4,58-59', expected: [0, 1, 2, 3, 4, 58, 59] },
    { field: '*/30,7', expected: [0, 7, 30] },
  ])('parses minute field "$field"', ({ field, expected }) => {
    const c = parseCron(`${field} * * * *`);
    expect([...c.minute].sort((a, b) => a - b)).toEqual(expected);
    expect(c.domRestricted).toBe(false);
  });

  it('normalizes day-of-week 7 to Sunday (0)', () => {
    const c = parseCron('0 0 * * 7');
    expect(c.dayOfWeek.has(0)).toBe(true);
    expect(c.dowRestricted).toBe(true);
  });

  it('marks a stepped field as restricted, not wildcard', () => {
    const c = parseCron('0 0 */2 * *');
    expect(c.domRestricted).toBe(true);
  });
});

describe('parseCron typed validation errors (CR-01)', () => {
  const cases: { expr: string; code: CronErrorCode }[] = [
    { expr: '* * * *', code: 'wrong-field-count' },
    { expr: '* * * * * *', code: 'wrong-field-count' },
    { expr: '60 * * * *', code: 'out-of-range' },
    { expr: '* 24 * * *', code: 'out-of-range' },
    { expr: '* * 0 * *', code: 'out-of-range' },
    { expr: '* * * 13 *', code: 'out-of-range' },
    { expr: '* * * * 8', code: 'out-of-range' },
    { expr: 'x * * * *', code: 'not-a-number' },
    { expr: '*/0 * * * *', code: 'bad-step' },
    { expr: '10-5 * * * *', code: 'bad-range' },
    { expr: '1,,2 * * * *', code: 'empty-field' },
  ];

  it.each(cases)('rejects "$expr" with code $code', ({ expr, code }) => {
    try {
      parseCron(expr);
      throw new Error(`expected "${expr}" to throw`);
    } catch (err) {
      expect(err).toBeInstanceOf(CronError);
      expect((err as CronError).code).toBe(code);
    }
  });

  it('reports the offending field on an out-of-range error', () => {
    try {
      parseCron('* * * 13 *');
    } catch (err) {
      expect((err as CronError).field).toBe('month');
    }
  });
});

describe('matches DOM/DOW OR semantics (CR-01)', () => {
  // Both day-of-month (13) and day-of-week (5 = Friday) are restricted -> match on EITHER.
  const expr = '0 0 13 * 5';

  it('matches when only day-of-month matches (the 13th, a Tuesday)', () => {
    expect(matches(expr, new Date(2026, 0, 13, 0, 0))).toBe(true);
  });

  it('matches when only day-of-week matches (a Friday, not the 13th)', () => {
    expect(matches(expr, new Date(2026, 0, 2, 0, 0))).toBe(true);
  });

  it('does not match when neither matches (the 6th, a Tuesday)', () => {
    expect(matches(expr, new Date(2026, 0, 6, 0, 0))).toBe(false);
  });

  it('requires BOTH when only one side is restricted (AND semantics)', () => {
    // day-of-month restricted, day-of-week wildcard -> the 15th at 00:00 only.
    expect(matches('0 0 15 * *', new Date(2026, 0, 15, 0, 0))).toBe(true);
    expect(matches('0 0 15 * *', new Date(2026, 0, 16, 0, 0))).toBe(false);
  });

  it('ignores seconds (minute granularity)', () => {
    expect(matches('30 9 * * *', new Date(2026, 0, 1, 9, 30, 45))).toBe(true);
  });
});

describe('nextFireAfter (CR-01/CR-02)', () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
    new Date(y, mo, d, h, mi, 0, 0).getTime();

  it.each([
    {
      name: 'every minute -> the next minute',
      expr: '* * * * *',
      from: local(2026, 0, 1, 9, 30),
      expect: local(2026, 0, 1, 9, 31),
    },
    {
      name: 'daily 09:30 -> tomorrow when already past',
      expr: '30 9 * * *',
      from: local(2026, 0, 1, 10, 0),
      expect: local(2026, 0, 2, 9, 30),
    },
    {
      name: 'top of next hour',
      expr: '0 * * * *',
      from: local(2026, 0, 1, 9, 30),
      expect: local(2026, 0, 1, 10, 0),
    },
    {
      name: 'strictly after an exact match',
      expr: '30 9 * * *',
      from: local(2026, 0, 1, 9, 30),
      expect: local(2026, 0, 2, 9, 30),
    },
    {
      name: 'every 15 minutes',
      expr: '*/15 * * * *',
      from: local(2026, 0, 1, 9, 7),
      expect: local(2026, 0, 1, 9, 15),
    },
    {
      name: 'first of the month at midnight',
      expr: '0 0 1 * *',
      from: local(2026, 0, 15, 12, 0),
      expect: local(2026, 1, 1, 0, 0),
    },
  ])('$name', ({ expr, from, expect: want }) => {
    expect(nextFireAfter(expr, from).getTime()).toBe(want);
  });

  it('throws on an unsatisfiable expression (February 30th)', () => {
    expect(() => nextFireAfter('0 0 30 2 *', local(2026, 0, 1, 0, 0))).toThrow(CronError);
  });
});
