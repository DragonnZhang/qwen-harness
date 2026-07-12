/**
 * Redaction at the provider boundary (PV-12).
 *
 * This is the last place a credential could plausibly leak: a server can echo part of a request
 * back inside an error message, and an error message ends up in logs, event payloads, support
 * bundles, and the terminal. So every provider-authored string is scrubbed and bounded BEFORE it
 * becomes a `HarnessError`, not when someone remembers to scrub it at the log call.
 */

/** DashScope keys are `sk-…`; the Authorization header carries them as `Bearer sk-…`. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

/** A provider string could otherwise rewrite a terminal line with escape sequences (TL-14). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Provider messages are user-visible; a runaway body must not become a 2 MB log line. */
const MAX_MESSAGE_LENGTH = 500;

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** Redact, neutralize control characters, and bound the length. Safe to log and to show a user. */
export function safeProviderMessage(text: string): string {
  const flattened = redact(text).replace(CONTROL_CHARACTERS, ' ');
  return flattened.length > MAX_MESSAGE_LENGTH
    ? `${flattened.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]`
    : flattened;
}
