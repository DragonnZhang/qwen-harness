/**
 * @qwen-harness/telemetry
 *
 * Local, opt-in, redacted observability (OB-01/OB-02). It never requires an external analytics
 * service and never emits a secret: every record passes through an injected redactor before it is
 * written, so a leaked value is impossible by construction. Traces are JSONL — readable by a human
 * or the implementing agent with `cat`.
 *
 * This is a declared I/O owner: only `file-sink.ts` touches the filesystem.
 */

export { Tracer, MemoryTraceSink, NULL_SINK } from './trace.ts';
export type { TraceRecord, TraceSink, TraceLevel, TracerOptions } from './trace.ts';
export { FileTraceSink } from './file-sink.ts';
