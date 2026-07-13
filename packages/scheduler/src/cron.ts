/**
 * Standard five-field cron: parsing, minute-granular matching, and next-fire computation (CR-01).
 *
 * Everything here is PURE and DETERMINISTIC. `matches` and `nextFireAfter` take an injected instant
 * (a number of epoch milliseconds or a `Date`) — never `Date.now()` — so a scheduler built on top of
 * them replays identically (RT-08). The local timezone is deliberately the host's: cron semantics are
 * defined in local time (docs/product/defaults.md, "Cron defaults"), and JS `Date` accessors
 * (`getHours`, `getDate`, `getDay`, ...) read local time, which is exactly what we want.
 *
 * Fields, in order: minute hour day-of-month month day-of-week.
 *
 *   minute        0-59
 *   hour          0-23
 *   day-of-month  1-31
 *   month         1-12
 *   day-of-week   0-6   (0 = Sunday; 7 is accepted as an alias for Sunday)
 *
 * DOM/DOW OR semantics (the one genuinely surprising cron rule): when BOTH day-of-month and
 * day-of-week are restricted (neither is `*`), a date matches if EITHER field matches. When only one
 * is restricted, the wildcard one imposes no constraint and the restricted one must match. This is
 * the behavior of Vixie cron and what operators expect from `0 0 13 * 5` ("midnight on the 13th, and
 * every Friday").
 */

/** A field's inclusive numeric bounds. */
interface FieldSpec {
  readonly name: CronFieldName;
  readonly min: number;
  readonly max: number;
}

export type CronFieldName = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week';

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
];

/** Why a cron expression was rejected. Stable codes so a caller can branch, not string-match. */
export type CronErrorCode =
  'wrong-field-count' | 'empty-field' | 'not-a-number' | 'out-of-range' | 'bad-range' | 'bad-step';

/**
 * A typed, precise parse failure (CR-01). Carries the offending field and a machine-readable
 * `code`, so validation UI and tests assert on structure rather than on message text.
 */
export class CronError extends Error {
  readonly code: CronErrorCode;
  readonly field: CronFieldName | null;
  readonly token: string | null;

  constructor(
    code: CronErrorCode,
    message: string,
    opts: { field?: CronFieldName; token?: string } = {},
  ) {
    super(message);
    this.name = 'CronError';
    this.code = code;
    this.field = opts.field ?? null;
    this.token = opts.token ?? null;
  }
}

/**
 * A parsed expression. Each field is the exact set of matching numbers; `domRestricted` /
 * `dowRestricted` remember whether the source field was a wildcard, because the DOM/DOW OR rule
 * depends on it and cannot be recovered from the value set alone (`*` and `0-6` share a set).
 */
export interface CronExpr {
  readonly source: string;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/** How far ahead `nextFireAfter` is willing to search before declaring an expression unsatisfiable. */
const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

const MINUTE_MS = 60_000;

function toInt(token: string, field: CronFieldName): number {
  if (!/^\d+$/.test(token)) {
    throw new CronError('not-a-number', `${field}: "${token}" is not a non-negative integer`, {
      field,
      token,
    });
  }
  return Number.parseInt(token, 10);
}

/**
 * Parse one field into its value set. Supports a wildcard, a wildcard with a step, a single value,
 * a range, a range with a step, a bare value with a step, and comma-separated lists of any of those.
 * Day-of-week `7` normalizes to `0` (Sunday).
 */
function parseField(raw: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
  if (raw.length === 0) {
    throw new CronError('empty-field', `${spec.name}: empty field`, { field: spec.name });
  }
  const values = new Set<number>();
  const restricted = raw !== '*';

  for (const part of raw.split(',')) {
    if (part.length === 0) {
      throw new CronError('empty-field', `${spec.name}: empty list element in "${raw}"`, {
        field: spec.name,
      });
    }

    const [rangePart, stepPart, ...extra] = part.split('/');
    if (extra.length > 0 || rangePart === undefined) {
      throw new CronError('bad-step', `${spec.name}: malformed step in "${part}"`, {
        field: spec.name,
        token: part,
      });
    }

    let step = 1;
    if (stepPart !== undefined) {
      step = toInt(stepPart, spec.name);
      if (step === 0) {
        throw new CronError('bad-step', `${spec.name}: step must be >= 1 in "${part}"`, {
          field: spec.name,
          token: part,
        });
      }
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...more] = rangePart.split('-');
      if (more.length > 0 || a === undefined || b === undefined) {
        throw new CronError('bad-range', `${spec.name}: malformed range "${rangePart}"`, {
          field: spec.name,
          token: part,
        });
      }
      lo = normalize(toInt(a, spec.name), spec);
      hi = normalize(toInt(b, spec.name), spec);
      if (lo > hi) {
        throw new CronError('bad-range', `${spec.name}: range start ${lo} exceeds end ${hi}`, {
          field: spec.name,
          token: part,
        });
      }
    } else {
      // A bare number. With an explicit step (`a/n`) it seeds a range up to the field maximum;
      // without one it is a single value.
      lo = normalize(toInt(rangePart, spec.name), spec);
      hi = stepPart === undefined ? lo : spec.max;
    }

    assertInRange(lo, spec, part);
    assertInRange(hi, spec, part);

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return { values, restricted };
}

/** Day-of-week 7 means Sunday, same as 0. Other fields pass through unchanged. */
function normalize(value: number, spec: FieldSpec): number {
  if (spec.name === 'day-of-week' && value === 7) return 0;
  return value;
}

function assertInRange(value: number, spec: FieldSpec, token: string): void {
  if (value < spec.min || value > spec.max) {
    throw new CronError(
      'out-of-range',
      `${spec.name}: ${value} is outside ${spec.min}-${spec.max}`,
      { field: spec.name, token },
    );
  }
}

/**
 * Parse a five-field cron expression into a {@link CronExpr}. Whitespace between fields may be any
 * run of spaces/tabs; leading and trailing whitespace is ignored. Throws {@link CronError} on any
 * malformed or out-of-range field.
 */
export function parseCron(expr: string): CronExpr {
  const fields = expr
    .trim()
    .split(/\s+/)
    .filter((f) => f.length > 0);
  if (fields.length !== 5) {
    throw new CronError(
      'wrong-field-count',
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }

  const parsed = FIELD_SPECS.map((spec, i) => parseField(fields[i] as string, spec));
  const [minute, hour, dom, month, dow] = parsed;

  return {
    source: expr.trim(),
    minute: (minute as { values: Set<number> }).values,
    hour: (hour as { values: Set<number> }).values,
    dayOfMonth: (dom as { values: Set<number> }).values,
    month: (month as { values: Set<number> }).values,
    dayOfWeek: (dow as { values: Set<number> }).values,
    domRestricted: (dom as { restricted: boolean }).restricted,
    dowRestricted: (dow as { restricted: boolean }).restricted,
  };
}

function asExpr(expr: CronExpr | string): CronExpr {
  return typeof expr === 'string' ? parseCron(expr) : expr;
}

function asDate(instant: number | Date): Date {
  return instant instanceof Date ? instant : new Date(instant);
}

/**
 * Does the minute containing `instant` match the expression? Local time; seconds and milliseconds
 * are ignored (cron is minute-granular). Implements the DOM/DOW OR rule.
 */
export function matches(expr: CronExpr | string, instant: number | Date): boolean {
  const c = asExpr(expr);
  const d = asDate(instant);

  if (!c.minute.has(d.getMinutes())) return false;
  if (!c.hour.has(d.getHours())) return false;
  if (!c.month.has(d.getMonth() + 1)) return false;

  const domMatch = c.dayOfMonth.has(d.getDate());
  const dowMatch = c.dayOfWeek.has(d.getDay());

  // Both restricted -> OR; otherwise the wildcard side is vacuously true and we require the other.
  if (c.domRestricted && c.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * The first firing instant STRICTLY AFTER `instant` (CR-01/CR-02). Returns a `Date` aligned to the
 * start of the matching minute (seconds and milliseconds zeroed) — the "date-aware minute marker"
 * the scheduler keys on. Pure and deterministic given the injected instant.
 *
 * Search is minute-by-minute (via `setMinutes`, so hour/day/month/DST rollovers are handled by the
 * platform) and bounded: an unsatisfiable expression such as `0 0 30 2 *` (February 30th) throws
 * rather than looping forever.
 */
export function nextFireAfter(expr: CronExpr | string, instant: number | Date): Date {
  const c = asExpr(expr);
  const start = asDate(instant);

  // Begin at the start of the NEXT minute: firing is strictly after `instant`, minimum one minute.
  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + MINUTE_MS);

  for (let i = 0; i < MAX_SEARCH_MINUTES; i += 1) {
    if (matches(c, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new CronError(
    'out-of-range',
    `no firing instant within ${MAX_SEARCH_MINUTES} minutes of ${start.toISOString()}; expression "${c.source}" is unsatisfiable`,
  );
}

/**
 * The nominal interval of a recurring expression at a given instant: the gap in milliseconds between
 * the next two firings. Used to size deterministic jitter. Returns `null` for an expression whose
 * next two firings cannot both be found (e.g. a once-a-year expression near the search bound is still
 * fine; only genuinely unsatisfiable ones return null via the thrown error being caught upstream).
 */
export function nominalIntervalMs(expr: CronExpr | string, instant: number | Date): number {
  const first = nextFireAfter(expr, instant);
  const second = nextFireAfter(expr, first);
  return second.getTime() - first.getTime();
}
