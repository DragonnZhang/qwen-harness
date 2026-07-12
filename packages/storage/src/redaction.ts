/**
 * Redaction runs at the STORAGE boundary, not at the logging boundary.
 *
 * That placement is deliberate. If redaction only happened on the way to a log, a secret would
 * still be sitting in the SQLite file, in the JSONL export, and in the support bundle. Redacting
 * before persistence means every downstream artifact is clean by construction (threat model,
 * "Secret handling"; PV-12).
 */

/** Patterns that are credential material regardless of where they appear. */
const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'dashscope-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github-token', re: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: 'bearer-header',
    re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
  },
  {
    name: 'authorization-header',
    re: /("?authorization"?\s*[:=]\s*")([^"]+)(")/gi,
  },
  {
    name: 'private-key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g,
  },
  {
    name: 'url-userinfo',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
  },
  {
    name: 'api-key-query',
    re: /([?&](?:api[_-]?key|access[_-]?token|token)=)[^&\s]+/gi,
  },
];

export const REDACTED = '[REDACTED]';

/**
 * Extra values to scrub exactly — the live credential and its common encodings.
 *
 * A key can leak in a form no regex anticipates: base64'd into a header dump, percent-encoded
 * into a URL. So we scrub the *actual value* and its encodings too, not just things that look
 * like keys.
 */
export function encodedVariants(secret: string): string[] {
  if (!secret) return [];
  const variants = new Set<string>([secret]);
  variants.add(Buffer.from(secret, 'utf8').toString('base64'));
  variants.add(Buffer.from(secret, 'utf8').toString('base64url'));
  variants.add(encodeURIComponent(secret));
  variants.add(Buffer.from(`Bearer ${secret}`, 'utf8').toString('base64'));
  // Only variants long enough to be unambiguous. A 4-char "secret" would scrub half the corpus.
  return [...variants].filter((v) => v.length >= 12);
}

export class Redactor {
  #literals: string[] = [];

  /**
   * Register a secret value to scrub exactly. The value is held only in memory, is never logged,
   * and never leaves this object.
   */
  addSecret(secret: string | undefined): this {
    if (secret && secret.length >= 8) this.#literals.push(...encodedVariants(secret));
    // Longest-first, so a longer encoding is replaced before a shorter substring of it.
    this.#literals.sort((a, b) => b.length - a.length);
    return this;
  }

  redact(input: string): string {
    let out = input;
    for (const literal of this.#literals) {
      if (literal && out.includes(literal)) out = out.split(literal).join(REDACTED);
    }
    for (const { re, name } of PATTERNS) {
      re.lastIndex = 0;
      out =
        name === 'authorization-header'
          ? out.replace(re, `$1${REDACTED}$3`)
          : name === 'url-userinfo'
            ? out.replace(re, `$1${REDACTED}@`)
            : name === 'api-key-query'
              ? out.replace(re, `$1${REDACTED}`)
              : out.replace(re, REDACTED);
    }
    return out;
  }

  /** Deep-redact any JSON-serializable value, including object KEYS that name a secret. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    // `Array.isArray` on a generic narrows to `any[]`, which would make the map an unsafe return.
    // Widening to `unknown[]` keeps the recursion fully typed.
    if (Array.isArray(value)) {
      return (value as unknown[]).map((v) => this.redactValue(v)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // A field literally named `authorization` / `api_key` / `password` is redacted wholesale,
        // no matter what its value looks like.
        out[k] = SENSITIVE_KEY.test(k) && typeof v === 'string' ? REDACTED : this.redactValue(v);
      }
      return out as unknown as T;
    }
    return value;
  }
}

const SENSITIVE_KEY =
  /^(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|cookie|set-cookie)$/i;

/** The default redactor: pattern-based only. Callers add live secret values via `addSecret`. */
export function createRedactor(secrets: (string | undefined)[] = []): Redactor {
  const r = new Redactor();
  for (const s of secrets) r.addSecret(s);
  return r;
}
