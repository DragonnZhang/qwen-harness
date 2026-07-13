import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TraceRecord, TraceSink } from './trace.ts';

/**
 * Writes trace records as JSONL to a local file. This is the I/O-owning part of telemetry — it is
 * the only place in the package that touches the filesystem (the graph's `IO_OWNERS.telemetry`).
 *
 * JSONL, not a binary format, because a trace must be readable by both a human and the implementing
 * agent with nothing more than `cat` (OB-02). Records are already redacted by the `Tracer` before
 * they arrive here, so a leaked secret is impossible by construction — this layer never sees a raw
 * value.
 */
export class FileTraceSink implements TraceSink {
  #ready = false;

  constructor(private readonly path: string) {}

  write(record: TraceRecord): void {
    if (!this.#ready) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.#ready = true;
    }
    appendFileSync(this.path, JSON.stringify(record) + '\n', 'utf8');
  }
}
