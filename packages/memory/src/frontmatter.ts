/**
 * The long-term memory document format (MM-01).
 *
 * A memory is a Markdown file with a validated YAML frontmatter block:
 *
 *   ---
 *   name: prefers-pnpm
 *   description: The user builds and tests with pnpm, never npm or yarn.
 *   type: user
 *   ---
 *   Always run `pnpm install` / `pnpm test`; npm lockfiles are not committed.
 *
 * The frontmatter is DATA, validated against a zod schema at the boundary. Invalid frontmatter is a
 * typed error that NAMES the offending file, never a silent partial parse — a memory the runtime
 * cannot trust must fail loudly, not degrade into a half-populated record.
 *
 * We parse a deliberately small, unambiguous subset of YAML (one scalar per key, optional quoting)
 * rather than pull in a full YAML engine. The frozen frontmatter is exactly three scalar fields, so
 * a full parser would add surface area — and YAML's implicit typing footguns — for no benefit. Any
 * construct outside the subset is rejected with a message that names the file and the line.
 */

import { z } from 'zod';

/** The four frozen memory types (MM-01). */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/**
 * A slug name: lowercase, digits, and single hyphens. Names are also file stems, so they must be
 * path-safe (no `/`, no `.`, no traversal) by construction — that is enforced HERE so a malicious
 * frontmatter can never name a file outside the memory directory.
 */
export const MEMORY_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MemoryNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    MEMORY_NAME_RE,
    'memory name must be a slug: lowercase letters, digits, and single hyphens (path-safe)',
  );

/**
 * The validated frontmatter. `description` is a single-line human summary used for retrieval
 * side-selection (MM-02), so newlines are rejected — a description that spanned lines would corrupt
 * both the index and the serialized frontmatter.
 */
export const MemoryFrontmatterSchema = z.strictObject({
  name: MemoryNameSchema,
  description: z
    .string()
    .min(1)
    .max(500)
    .refine((v) => !/[\r\n]/.test(v), 'description must be a single line'),
  type: MemoryTypeSchema,
});

export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

/** A parsed memory document: its validated frontmatter plus the Markdown body. */
export interface Memory extends MemoryFrontmatter {
  /** The Markdown body, with the trailing newline normalized away. */
  readonly body: string;
}

/**
 * A typed parse failure that always names the file. `file` is the logical source (a path when the
 * memory came from disk, or a synthetic label for an in-memory candidate) so a caller can point a
 * user at exactly which memory is malformed.
 */
export class MemoryFormatError extends Error {
  readonly file: string;
  readonly line: number | undefined;

  constructor(file: string, detail: string, options?: { line?: number; cause?: unknown }) {
    super(`invalid memory ${file}: ${detail}`);
    this.name = 'MemoryFormatError';
    this.file = file;
    this.line = options?.line;
  }
}

const FRONTMATTER_DELIMITER = '---';

/**
 * Split a document into its raw frontmatter block and body. A memory file MUST start with a `---`
 * fence; a file without one has no metadata and cannot be trusted as a memory, so that is an error
 * rather than a "body-only" fallback.
 */
function splitDocument(text: string, file: string): { yaml: string; body: string } {
  // Tolerate a UTF-8 BOM and leading blank lines before the opening fence.
  const normalized = text.replace(/^﻿/, '');
  const lines = normalized.split('\n');

  let i = 0;
  while (i < lines.length && lines[i]?.trim() === '') i++;
  if (lines[i]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new MemoryFormatError(file, 'missing YAML frontmatter (expected a leading "---" fence)', {
      line: i + 1,
    });
  }
  const openFence = i;
  i++;

  const yamlLines: string[] = [];
  let closeFence = -1;
  for (; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
      closeFence = i;
      break;
    }
    yamlLines.push(lines[i] ?? '');
  }
  if (closeFence === -1) {
    throw new MemoryFormatError(file, 'unterminated YAML frontmatter (no closing "---" fence)', {
      line: openFence + 1,
    });
  }

  const bodyLines = lines.slice(closeFence + 1);
  return { yaml: yamlLines.join('\n'), body: bodyLines.join('\n') };
}

/** Strip one layer of matching single or double quotes and unescape the minimal set we serialize. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      // Only the escapes we ourselves emit: \" and \\.
      return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (first === "'" && last === "'") {
      // YAML single-quote escaping doubles the quote.
      return value.slice(1, -1).replace(/''/g, "'");
    }
  }
  return value;
}

/**
 * Parse the small YAML subset: `key: value` lines, blank lines, and `#` comments. Duplicate keys
 * are rejected (last-write-wins is exactly how a crafted memory would smuggle a value past review).
 */
function parseFrontmatterYaml(yaml: string, file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = yaml.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const rawLine = lines[n] ?? '';
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const colon = rawLine.indexOf(':');
    if (colon === -1) {
      throw new MemoryFormatError(file, `frontmatter line is not "key: value": ${line}`, {
        line: n + 1,
      });
    }
    const key = rawLine.slice(0, colon).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
      throw new MemoryFormatError(file, `invalid frontmatter key: ${key}`, { line: n + 1 });
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new MemoryFormatError(file, `duplicate frontmatter key: ${key}`, { line: n + 1 });
    }
    // Strip an inline comment only when the value is unquoted; a `#` inside quotes is literal.
    let rest = rawLine.slice(colon + 1);
    const trimmedRest = rest.trim();
    if (!(trimmedRest.startsWith('"') || trimmedRest.startsWith("'"))) {
      const hash = rest.indexOf(' #');
      if (hash !== -1) rest = rest.slice(0, hash);
    }
    out[key] = unquote(rest);
  }
  return out;
}

/**
 * Parse a memory document into a validated {@link Memory}. `file` names the source for error
 * messages. Any failure — missing fence, bad YAML line, or a frontmatter value that fails the
 * schema — is a {@link MemoryFormatError} that names the file.
 */
export function parseMemory(text: string, file = '<memory>'): Memory {
  const { yaml, body } = splitDocument(text, file);
  const raw = parseFrontmatterYaml(yaml, file);

  const result = MemoryFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new MemoryFormatError(file, detail);
  }

  return { ...result.data, body: body.replace(/\n+$/, '') };
}

/** Does a value need quoting to round-trip safely through {@link parseFrontmatterYaml}? */
function needsQuoting(value: string): boolean {
  return (
    value === '' ||
    value !== value.trim() ||
    /[:#'"]/.test(value) ||
    value.startsWith('- ') ||
    value.startsWith('[') ||
    value.startsWith('{')
  );
}

function quote(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a memory back to `---`-fenced Markdown. `parseMemory(serializeMemory(m))` round-trips
 * for every valid memory, which is the property the format's tests assert.
 */
export function serializeMemory(memory: Memory): string {
  const frontmatter = MemoryFrontmatterSchema.parse({
    name: memory.name,
    description: memory.description,
    type: memory.type,
  });
  const lines = [
    FRONTMATTER_DELIMITER,
    `name: ${quote(frontmatter.name)}`,
    `description: ${quote(frontmatter.description)}`,
    `type: ${frontmatter.type}`,
    FRONTMATTER_DELIMITER,
    '',
  ];
  const body = memory.body.replace(/\n+$/, '');
  return `${lines.join('\n')}${body}${body === '' ? '' : '\n'}`;
}
