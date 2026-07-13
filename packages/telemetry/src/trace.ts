import type { Clock } from '@qwen-harness/protocol';

/**
 * Local, structured, redacted observability (OB-01/OB-02).
 *
 * Telemetry is LOCAL and OPT-IN. It never requires an external analytics service, and it never
 * emits a secret: every record passes through the injected `redact` function before it is written.
 * A trace is a stream of typed spans and events an operator (or the implementing agent) can read
 * back as JSON — not a vendor SDK.
 */

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceRecord {
  readonly ts: number;
  readonly level: TraceLevel;
  /** Dotted category, e.g. `provider.request`, `tool.execute`, `policy.decision`. */
  readonly category: string;
  readonly message: string;
  /** Structured, already-redacted fields. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Correlation id, so a whole user intent can be followed across components. */
  readonly correlationId: string | null;
}

/** The sink a trace writes to. `FileTraceSink` implements it; tests use an in-memory one. */
export interface TraceSink {
  write(record: TraceRecord): void;
}

/** A no-op sink. Telemetry is opt-in, so this is the default when it is disabled. */
export const NULL_SINK: TraceSink = { write: () => {} };

/** Collects records in memory — for tests and for a support-bundle snapshot. */
export class MemoryTraceSink implements TraceSink {
  readonly records: TraceRecord[] = [];
  write(record: TraceRecord): void {
    this.records.push(record);
  }
}

export interface TracerOptions {
  readonly clock: Clock;
  readonly sink: TraceSink;
  /** Redacts a value before it is written. Wire this to storage's Redactor at the app boundary. */
  readonly redact: (value: unknown) => unknown;
  readonly minLevel?: TraceLevel;
  readonly correlationId?: string | null;
}

const LEVEL_RANK: Record<TraceLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * The tracer. It stamps time from the injected clock (so traces are deterministic under test) and
 * redacts every field before writing — redaction is not the caller's responsibility to remember.
 */
export class Tracer {
  readonly #clock: Clock;
  readonly #sink: TraceSink;
  readonly #redact: (value: unknown) => unknown;
  readonly #minRank: number;
  readonly #correlationId: string | null;

  constructor(opts: TracerOptions) {
    this.#clock = opts.clock;
    this.#sink = opts.sink;
    this.#redact = opts.redact;
    this.#minRank = LEVEL_RANK[opts.minLevel ?? 'debug'];
    this.#correlationId = opts.correlationId ?? null;
  }

  /** A child tracer that tags every record with a correlation id. */
  withCorrelation(correlationId: string): Tracer {
    return new Tracer({
      clock: this.#clock,
      sink: this.#sink,
      redact: this.#redact,
      minLevel: rankToLevel(this.#minRank),
      correlationId,
    });
  }

  emit(
    level: TraceLevel,
    category: string,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    if (LEVEL_RANK[level] < this.#minRank) return;
    this.#sink.write({
      ts: this.#clock.now(),
      level,
      category,
      // The message can carry interpolated values, so it is redacted too — not just the fields.
      message: String(this.#redact(message)),
      fields: this.#redact(fields) as Record<string, unknown>,
      correlationId: this.#correlationId,
    });
  }

  debug(category: string, message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', category, message, fields);
  }
  info(category: string, message: string, fields?: Record<string, unknown>): void {
    this.emit('info', category, message, fields);
  }
  warn(category: string, message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', category, message, fields);
  }
  error(category: string, message: string, fields?: Record<string, unknown>): void {
    this.emit('error', category, message, fields);
  }

  /**
   * Times an operation and emits a span record with its duration. Returns the callback result. A
   * throw is recorded (with a redacted message) and re-thrown — telemetry never swallows an error.
   */
  async span<T>(category: string, message: string, fn: () => Promise<T>): Promise<T> {
    const start = this.#clock.now();
    try {
      const result = await fn();
      this.emit('info', category, message, { durationMs: this.#clock.now() - start, ok: true });
      return result;
    } catch (e) {
      this.emit('error', category, message, {
        durationMs: this.#clock.now() - start,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}

function rankToLevel(rank: number): TraceLevel {
  return (Object.keys(LEVEL_RANK) as TraceLevel[]).find((l) => LEVEL_RANK[l] === rank) ?? 'debug';
}
