# @qwen-harness/telemetry

Local, opt-in, redacted observability (OB-01/OB-02).

Telemetry never requires an external analytics service and never emits a secret. Every record
passes through an injected redactor **inside the `Tracer`** before it reaches any sink, so a leaked
value is impossible at the boundary that writes — not something each caller must remember. Wire the
redactor to storage's `Redactor` at the app boundary.

Traces are JSONL so an operator or the implementing agent can read them with `cat` (OB-02). Time is
stamped from an injected `Clock`, so traces are deterministic under test.

`FileTraceSink` is the only part that touches the filesystem (this package's single `IO_OWNERS`
entry). `MemoryTraceSink` is for tests and support-bundle snapshots; `NULL_SINK` is the default when
telemetry is disabled (opt-in).

`Tracer.span` times an operation and records its duration; a throw is recorded with a redacted
message and re-thrown — telemetry never swallows an error.
