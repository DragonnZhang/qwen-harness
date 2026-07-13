/**
 * SKILL.md frontmatter: the untrusted-input boundary of the whole package (IN-04).
 *
 * A skill is a Markdown file with a `---`-fenced metadata block:
 *
 *   ---
 *   name: review-pr
 *   description: Review a pull request against the repository's conventions.
 *   condition: Use when the user asks for a code review or mentions a PR number.
 *   context: forked
 *   allowed-tools: [read_file, grep, git_status]
 *   model: qwen3.7-max
 *   paths: ["src/**", "packages/**"]
 *   resources: [scripts/lint.sh, references/checklist.md]
 *   hooks:
 *     skill-start: scripts/prepare.sh
 *   user-invocable: true
 *   command: review
 *   argument-hint: <pr-number>
 *   ---
 *   ...body...
 *
 * EVERY byte above is attacker-controlled: a SKILL.md can arrive from a repository a user merely
 * opened, from a plugin, or from an MCP server (docs/security/threat-model.md — skill loading is an
 * untrusted-content path). Therefore:
 *
 *   1. The frontmatter is parsed into plain data and validated by a STRICT zod schema. An unknown
 *      key is an error, not something we ignore: an unknown key is either a typo (the user wants to
 *      know) or a field from a future/foreign format someone hopes we will honor (we will not).
 *   2. Nothing in here is authority. `allowed-tools` can only ever REMOVE tools from what the
 *      caller already holds (see execution.ts); `model` is a HINT; `hooks`/`resources`/`paths` are
 *      relative paths that the registry re-validates against the canonical skill root (scope.ts).
 *   3. Failure is a typed `SkillFrontmatterError` naming file and field. Never a crash, never a
 *      silently dropped skill.
 *
 * We parse a small, explicit YAML subset rather than pulling in a YAML engine — the same call
 * `packages/memory` makes, and for the same reason: YAML's implicit typing, anchors, merge keys and
 * multi-document support are pure attack surface for a format that is a dozen scalar fields, a
 * couple of lists, and one flat mapping.
 */

import { z } from 'zod';

import { SkillFrontmatterError } from './errors.ts';

/** Lifecycle points a skill may attach a script to. Frozen: a skill cannot invent a hook event. */
export const SKILL_HOOK_EVENTS = [
  'skill-start',
  'skill-end',
  'pre-tool-use',
  'post-tool-use',
] as const;
export type SkillHookEvent = (typeof SKILL_HOOK_EVENTS)[number];

/** How a skill's body enters the conversation (IN-05). */
export const SKILL_CONTEXT_MODES = ['inline', 'forked'] as const;
export type SkillContextMode = (typeof SKILL_CONTEXT_MODES)[number];

/**
 * A skill name is a slug AND a registry key AND (for file skills) a directory name. Making it a
 * strict slug is what guarantees a name can never be a path: no `/`, no `.`, no `..`, no NUL. A
 * hostile frontmatter therefore cannot use `name` to reach outside anything.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    SKILL_NAME_RE,
    'skill name must be a slug: lowercase letters, digits, and single hyphens (path-safe)',
  );

const SingleLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !/[\r\n\u2028\u2029]/.test(v), 'must be a single line');

/** A tool name as the policy/tool layer knows it. Bounded and inert — never a glob, never a path. */
const ToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'tool name must be alphanumeric with . _ : -');

/**
 * A RELATIVE path inside the skill. Rejected here: absolute paths, `..` segments, NUL, and `~`.
 * This is the FIRST of two independent barriers — scope.ts then re-resolves the path with realpath
 * and re-checks containment, because string validation alone cannot see a symlink.
 */
const RelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !v.includes('\0'), 'must not contain a NUL byte')
  .refine((v) => !v.startsWith('/'), 'must be relative to the skill root, not absolute')
  .refine((v) => !v.startsWith('~'), 'must not start with "~"')
  .refine(
    (v) => !v.split('/').includes('..'),
    'must not contain a ".." segment (skill resources never escape the skill root)',
  );

/** A path-scope glob. Relative to the workspace; bounded; no NUL. */
const PathGlobSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.includes('\0'), 'must not contain a NUL byte');

/**
 * The strict schema. Keys are kebab-case exactly as authored in the file; `strictObject` rejects
 * anything else. Optionality is expressed here; defaults are applied in {@link normalizeFrontmatter}
 * so the normalized record has no optional properties at all (`exactOptionalPropertyTypes`).
 */
export const SkillFrontmatterSchema = z.strictObject({
  name: SkillNameSchema,
  description: SingleLine(1024),
  /** The usage condition the model reads in the catalog: "use this when ...". */
  condition: SingleLine(1024).optional(),
  /** Tools the skill may use. ABSENT means "inherit the caller's tools"; a LIST can only narrow. */
  'allowed-tools': z.array(ToolNameSchema).max(64).optional(),
  context: z.enum(SKILL_CONTEXT_MODES).optional(),
  /** A hint, never a decision: the runtime is free to ignore it and policy never consults it. */
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, 'model hint must be a plain model identifier')
    .optional(),
  hooks: z
    .strictObject({
      'skill-start': RelativePathSchema.optional(),
      'skill-end': RelativePathSchema.optional(),
      'pre-tool-use': RelativePathSchema.optional(),
      'post-tool-use': RelativePathSchema.optional(),
    })
    .optional(),
  /** Path globs that make this skill CONDITIONALLY relevant (see sources.ts / catalog.ts). */
  paths: z.array(PathGlobSchema).max(64).optional(),
  /** Scripts/assets/references the skill declares. Validated against the real root at registration. */
  resources: z.array(RelativePathSchema).max(64).optional(),
  'user-invocable': z.boolean().optional(),
  /** The slash-command name, when user-invocable. Defaults to `name`. */
  command: SkillNameSchema.optional(),
  'argument-hint': SingleLine(200).optional(),
});

export type RawSkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** How a user may invoke a skill directly (IN-04: "user invocation"). */
export interface SkillUserInvocation {
  readonly invocable: boolean;
  /** The `/command` name. `null` exactly when `invocable` is false. */
  readonly command: string | null;
  readonly argumentHint: string | null;
}

/** The validated, normalized frontmatter. Every field is present; optionality became `null`. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly condition: string | null;
  /** `null` = inherit the caller's tools. A list can only ever be intersected, never unioned. */
  readonly allowedTools: readonly string[] | null;
  readonly contextMode: SkillContextMode;
  readonly modelHint: string | null;
  readonly hooks: Readonly<Partial<Record<SkillHookEvent, string>>>;
  readonly paths: readonly string[];
  readonly resources: readonly string[];
  readonly userInvocation: SkillUserInvocation;
}

/** A parsed skill document: validated metadata plus the raw (still unloaded-elsewhere) body. */
export interface ParsedSkillDocument {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

// ---------------------------------------------------------------------------------------------
// The YAML subset
// ---------------------------------------------------------------------------------------------

const FENCE = '---';

type YamlValue = string | boolean | string[] | Record<string, string>;

/**
 * Split a document at its frontmatter fences. `file` names the source in every error.
 *
 * `requireFence: false` supports LEGACY COMMAND files (IN-03), which are plain Markdown with no
 * frontmatter at all. Skills proper always require the fence — a SKILL.md without metadata is not a
 * skill, and treating it as "a skill with defaults" would let an attacker drop an unreviewed file
 * into a scanned directory and have it silently become callable.
 */
export function splitFrontmatter(
  text: string,
  file: string,
  requireFence: boolean,
): { yaml: string | null; body: string; yamlStartLine: number } {
  const normalized = text.replace(/^﻿/, '');
  const lines = normalized.split('\n');

  let i = 0;
  while (i < lines.length && lines[i]?.trim() === '') i += 1;

  if (lines[i]?.trim() !== FENCE) {
    if (requireFence) {
      throw new SkillFrontmatterError(
        file,
        'missing frontmatter (expected a leading "---" fence)',
        {
          line: i + 1,
        },
      );
    }
    return { yaml: null, body: normalized, yamlStartLine: 1 };
  }

  const open = i;
  i += 1;
  const yamlLines: string[] = [];
  let close = -1;
  for (; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FENCE) {
      close = i;
      break;
    }
    yamlLines.push(lines[i] ?? '');
  }
  if (close === -1) {
    throw new SkillFrontmatterError(file, 'unterminated frontmatter (no closing "---" fence)', {
      line: open + 1,
    });
  }

  return {
    yaml: yamlLines.join('\n'),
    body: lines.slice(close + 1).join('\n'),
    yamlStartLine: open + 2,
  };
}

/** Strip one layer of matching quotes, unescaping only what our own serializer would emit. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** `[a, b, "c d"]` -> `['a','b','c d']`. An empty `[]` is a legal empty list. */
function parseFlowList(raw: string, file: string, line: number, key: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== null) {
    throw new SkillFrontmatterError(file, 'unterminated quote in list', { field: key, line });
  }
  items.push(current);
  return items.map((item) => unquote(item)).filter((item) => item !== '');
}

const KEY_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Parse the subset: `key: scalar`, `key: [flow, list]`, a block list of `- item`, and ONE level of
 * indented `key: value` mapping (used by `hooks`). Anything else — tabs, nested lists, anchors,
 * multi-document markers — is an error that names the line. Duplicate keys are rejected: silent
 * last-write-wins is exactly how a crafted file smuggles a value past a human reviewer.
 */
export function parseFrontmatterYaml(
  yaml: string,
  file: string,
  firstLine: number,
): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = yaml.split('\n');

  const set = (key: string, value: YamlValue, line: number): void => {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new SkillFrontmatterError(file, 'duplicate frontmatter key', { field: key, line });
    }
    out[key] = value;
  };

  for (let n = 0; n < lines.length; n += 1) {
    const rawLine = lines[n] ?? '';
    const lineNo = firstLine + n;
    if (rawLine.includes('\t')) {
      throw new SkillFrontmatterError(file, 'tabs are not permitted in frontmatter', {
        line: lineNo,
      });
    }
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // Indented lines belong to the key above; they are consumed by the block handlers below.
    if (/^\s/.test(rawLine)) {
      throw new SkillFrontmatterError(file, `unexpected indented line: ${trimmed}`, {
        line: lineNo,
      });
    }

    const colon = rawLine.indexOf(':');
    if (colon === -1) {
      throw new SkillFrontmatterError(file, `line is not "key: value": ${trimmed}`, {
        line: lineNo,
      });
    }
    const key = rawLine.slice(0, colon).trim();
    if (!KEY_RE.test(key)) {
      throw new SkillFrontmatterError(file, `invalid frontmatter key: ${JSON.stringify(key)}`, {
        line: lineNo,
      });
    }

    let rest = rawLine.slice(colon + 1);
    const restTrimmed = rest.trim();

    // An inline `#` comment is only a comment when the value is unquoted.
    if (!(restTrimmed.startsWith('"') || restTrimmed.startsWith("'"))) {
      const hash = rest.indexOf(' #');
      if (hash !== -1) rest = rest.slice(0, hash);
    }
    const value = rest.trim();

    if (value.startsWith('[')) {
      if (!value.endsWith(']')) {
        throw new SkillFrontmatterError(file, 'unterminated list (expected "]")', {
          field: key,
          line: lineNo,
        });
      }
      set(key, parseFlowList(value, file, lineNo, key), lineNo);
      continue;
    }

    if (value !== '') {
      set(key, unquote(value), lineNo);
      continue;
    }

    // An empty value means a block follows: either `- item` entries or an indented mapping.
    const block: string[] = [];
    let m = n + 1;
    for (; m < lines.length; m += 1) {
      const candidate = lines[m] ?? '';
      if (candidate.trim() === '') continue;
      if (!/^\s/.test(candidate)) break;
      if (candidate.includes('\t')) {
        throw new SkillFrontmatterError(file, 'tabs are not permitted in frontmatter', {
          field: key,
          line: firstLine + m,
        });
      }
      block.push(candidate);
    }
    if (block.length === 0) {
      throw new SkillFrontmatterError(file, 'key has no value', { field: key, line: lineNo });
    }

    const first = block[0] ?? '';
    if (first.trim().startsWith('- ')) {
      const items: string[] = [];
      for (let b = 0; b < block.length; b += 1) {
        const entry = (block[b] ?? '').trim();
        if (!entry.startsWith('- ')) {
          throw new SkillFrontmatterError(file, `expected a "- item" list entry: ${entry}`, {
            field: key,
            line: lineNo,
          });
        }
        items.push(unquote(entry.slice(2)));
      }
      set(key, items, lineNo);
    } else {
      const mapping: Record<string, string> = {};
      for (let b = 0; b < block.length; b += 1) {
        const entry = (block[b] ?? '').trim();
        const sub = entry.indexOf(':');
        if (sub === -1) {
          throw new SkillFrontmatterError(file, `expected "key: value" under "${key}": ${entry}`, {
            field: key,
            line: lineNo,
          });
        }
        const subKey = entry.slice(0, sub).trim();
        if (!KEY_RE.test(subKey)) {
          throw new SkillFrontmatterError(file, `invalid key under "${key}": ${subKey}`, {
            field: key,
            line: lineNo,
          });
        }
        if (Object.prototype.hasOwnProperty.call(mapping, subKey)) {
          throw new SkillFrontmatterError(file, `duplicate key under "${key}": ${subKey}`, {
            field: key,
            line: lineNo,
          });
        }
        mapping[subKey] = unquote(entry.slice(sub + 1));
      }
      set(key, mapping, lineNo);
    }
    n = m - 1;
  }

  return out;
}

/** Coerce the two scalar booleans we accept. Everything else is an error, never a truthy string. */
function coerceBooleans(raw: Record<string, YamlValue>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const value = out['user-invocable'];
  if (typeof value === 'string') {
    if (value === 'true') out['user-invocable'] = true;
    else if (value === 'false') out['user-invocable'] = false;
  }
  return out;
}

/** Turn a zod failure into an error that names the FIRST offending field, as IN-04 requires. */
function frontmatterError(file: string, error: z.ZodError): SkillFrontmatterError {
  const issues = error.issues;
  const first = issues[0];
  const field = first === undefined ? '' : first.path.join('.');
  const detail = issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return new SkillFrontmatterError(file, detail, { field: field === '' ? null : field });
}

function normalizeFrontmatter(raw: RawSkillFrontmatter): SkillFrontmatter {
  const hooks: Partial<Record<SkillHookEvent, string>> = {};
  const declared = raw.hooks;
  if (declared !== undefined) {
    for (const event of SKILL_HOOK_EVENTS) {
      const script = declared[event];
      if (script !== undefined) hooks[event] = script;
    }
  }

  const invocable = raw['user-invocable'] ?? false;

  return {
    name: raw.name,
    description: raw.description,
    condition: raw.condition ?? null,
    allowedTools: raw['allowed-tools'] ?? null,
    contextMode: raw.context ?? 'inline',
    modelHint: raw.model ?? null,
    hooks,
    paths: raw.paths ?? [],
    resources: raw.resources ?? [],
    userInvocation: {
      invocable,
      command: invocable ? (raw.command ?? raw.name) : null,
      argumentHint: raw['argument-hint'] ?? null,
    },
  };
}

/**
 * Parse and validate a skill document. Throws a {@link SkillFrontmatterError} naming file and
 * field on ANY failure — this is the single entry point through which untrusted skill metadata may
 * enter the system.
 */
export function parseSkillDocument(
  text: string,
  file: string,
  options: { requireFence?: boolean } = {},
): ParsedSkillDocument {
  const { yaml, body, yamlStartLine } = splitFrontmatter(text, file, options.requireFence ?? true);
  if (yaml === null) {
    throw new SkillFrontmatterError(file, 'missing frontmatter');
  }
  const raw = parseFrontmatterYaml(yaml, file, yamlStartLine);
  const parsed = SkillFrontmatterSchema.safeParse(coerceBooleans(raw));
  if (!parsed.success) throw frontmatterError(file, parsed.error);
  return { frontmatter: normalizeFrontmatter(parsed.data), body: body.replace(/\n+$/, '') };
}

/** Validate an already-structured frontmatter (dynamic, plugin, and MCP skills take this path). */
export function validateSkillFrontmatter(input: unknown, file: string): SkillFrontmatter {
  const parsed = SkillFrontmatterSchema.safeParse(input);
  if (!parsed.success) throw frontmatterError(file, parsed.error);
  return normalizeFrontmatter(parsed.data);
}

// ---------------------------------------------------------------------------------------------
// Argument substitution
// ---------------------------------------------------------------------------------------------

/**
 * Characters an argument may never contribute, because each one can forge STRUCTURE in a prompt:
 * newlines and the Unicode line separators (a new line can start a new directive or a `---` fence),
 * C0/C1 control characters (terminal escapes, and they are stripped everywhere else in the system),
 * and the bidi/format characters that let visible text disagree with what the model receives.
 */
const ARGUMENT_STRUCTURE_RE =
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Hard cap on one substituted argument, so an argument cannot flood the loaded skill body. */
export const MAX_ARGUMENT_CHARS = 4096;

/**
 * Neutralize ONE user/model-supplied argument.
 *
 * The rule is structural, not a blocklist of words: after neutralization an argument is a single
 * line of inert text with no control characters. It therefore cannot open a fence, cannot begin a
 * new Markdown heading on its own line, and cannot inject a terminal escape. Content that merely
 * LOOKS like an instruction is still possible (any free-text argument can say "ignore previous
 * instructions") — that is what the untrusted-text boundary and policy are for. What the argument
 * can never do is change the STRUCTURE of the skill document it lands in.
 */
export function neutralizeArgument(value: string): string {
  const collapsed = value.replace(/\r\n?|\n/g, ' ').replace(ARGUMENT_STRUCTURE_RE, '');
  const bounded =
    collapsed.length > MAX_ARGUMENT_CHARS ? collapsed.slice(0, MAX_ARGUMENT_CHARS) : collapsed;
  return bounded.trim();
}

export interface ArgumentSubstitution {
  readonly text: string;
  /** Placeholders that appeared in the body and were filled. */
  readonly substituted: readonly string[];
  /** Placeholders that appeared in the body with no corresponding argument (filled with ""). */
  readonly missing: readonly string[];
  /** True when any argument was altered by neutralization. Observable, never silent. */
  readonly neutralized: boolean;
}

const PLACEHOLDER_RE = /\$(ARGUMENTS|[1-9])/g;

/**
 * Substitute `$ARGUMENTS` and `$1`..`$9` in a skill body.
 *
 * ONE pass, via a single `replace` with a function: the replacement text is never rescanned, so an
 * argument containing `$1` cannot expand another argument, and an argument containing `$ARGUMENTS`
 * cannot expand the whole list. (A naive sequential `body.replace('$1', a).replace('$2', b)` chain
 * has exactly that recursive-expansion bug.)
 */
export function substituteArguments(body: string, args: readonly string[]): ArgumentSubstitution {
  const safe = args.map(neutralizeArgument);
  const neutralized = safe.some((value, i) => value !== args[i]);
  const substituted: string[] = [];
  const missing: string[] = [];

  const text = body.replace(PLACEHOLDER_RE, (_match, token: string) => {
    if (token === 'ARGUMENTS') {
      if (safe.length === 0) {
        missing.push('$ARGUMENTS');
        return '';
      }
      substituted.push('$ARGUMENTS');
      return safe.join(' ');
    }
    const index = Number(token) - 1;
    const value = safe[index];
    if (value === undefined) {
      missing.push(`$${token}`);
      return '';
    }
    substituted.push(`$${token}`);
    return value;
  });

  return { text, substituted, missing, neutralized };
}
