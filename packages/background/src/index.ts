/**
 * @qwen-harness/background
 *
 * One unified lifecycle for background work (capability matrix J, BG-01..BG-06).
 *
 * The package is pure coordination and a state machine: it opens no host capability (the architecture
 * gate forbids it), takes time as an injected `Clock` and process spawning as an injected `Runner`,
 * so the lifecycle is deterministic and testable without real processes or wall-clock waits.
 *
 *   - `category.ts`      — the three supported categories and the BG-01 placement classifier.
 *   - `notifications.ts` — the four-level FIFO priority queue with anti-starvation.
 *   - `runner.ts`        — the injected process boundary.
 *   - `sink.ts`          — the optional durable sink and its EventStore adapter.
 *   - `manager.ts`       — the `BackgroundManager` lifecycle, watchdog, and concurrency.
 */

export { BACKGROUND_CATEGORIES, isBackgroundCategory, classifyForeground } from './category.ts';
export type { BackgroundCategory, Placement, ForegroundHint } from './category.ts';

export {
  NotificationQueue,
  NOTIFICATION_LEVELS,
  STARVATION_THRESHOLD,
  levelOf,
} from './notifications.ts';
export type { Notification, NotificationKind, NotificationLevel } from './notifications.ts';

export type {
  Runner,
  RunnerControl,
  RunnerCallbacks,
  RunnerSpec,
  RunnerExit,
  InputRequest,
} from './runner.ts';

export {
  BackgroundManager,
  isTerminalStatus,
  FOREGROUND_CONCURRENCY,
  OUTPUT_WARN_BYTES,
  OUTPUT_HARD_STOP_BYTES,
  OUTPUT_PREVIEW_BYTES,
  INPUT_WATCHDOG_MS,
  BLOCKED_AFTER_MS,
} from './manager.ts';
export type {
  BackgroundManagerOptions,
  StartInput,
  BackgroundTaskView,
  TaskStatus,
} from './manager.ts';

export { eventStoreBackgroundSink, backgroundIdempotencyKey } from './sink.ts';
export type { BackgroundEventSink } from './sink.ts';
