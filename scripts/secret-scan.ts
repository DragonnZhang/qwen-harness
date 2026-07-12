/**
 * Credential scanner. Run with `pnpm secrets:scan`.
 *
 * Walks the working tree and fails if anything that looks like credential material is sitting in a
 * file that could be committed. The one thing it must never do is leak the very thing it is
 * looking for: when a match is on the live DASHSCOPE_API_KEY, only the file and line are printed —
 * never the value, never a prefix of it.
 *
 * `.env` / `.env.*` are excluded by design: they are gitignored and are exactly where the key is
 * supposed to live on a developer machine. Everything else is fair game.
 *
 * Scope: the working tree only. Committed history is covered by `scripts/check-spec.sh`; walking
 * `git log -p` here would make the gate too slow to run on every change.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Directories that are never source: build output, dependencies, VCS internals. */
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.pnpm-store',
  '.turbo',
  '.cache',
]);

/** Files that are allowed to hold a real key locally. They are gitignored. */
const isEnvFile = (name: string): boolean => name === '.env' || name.startsWith('.env.');

/** Binary-ish extensions: scanning them yields noise, not secrets. */
const SKIPPED_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.woff',
  '.woff2',
  '.ttf',
  '.wasm',
  '.node',
  '.sqlite',
];

const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /** True when a match reveals the live credential and must never be echoed. */
  readonly redact: boolean;
}

interface Hit {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly evidence: string;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const rules: Rule[] = [
  { name: 'api key (sk-…)', pattern: /sk-[A-Za-z0-9_-]{16,}/g, redact: false },
  {
    name: 'GitHub token',
    pattern: /gh[opusr]_[A-Za-z0-9]{20,}/g,
    redact: false,
  },
  { name: 'AWS access key id', pattern: /AKIA[0-9A-Z]{16}/g, redact: false },
  {
    name: 'private key header',
    pattern: /-----BEGIN (?:RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g,
    redact: false,
  },
];

/**
 * If the real key is present in the environment at scan time, look for it verbatim and in the two
 * encodings a key most often survives: base64 and percent-encoding. This is the rule that catches
 * a genuine key that was pasted into a source file, a fixture, or a snapshot.
 */
const liveKey = process.env['DASHSCOPE_API_KEY'];
const liveKeyRules: Rule[] = [];
if (liveKey !== undefined && liveKey.trim().length >= 8) {
  const key = liveKey.trim();
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const encodings: Array<[string, string]> = [
    ['live DASHSCOPE_API_KEY (literal)', key],
    ['live DASHSCOPE_API_KEY (base64)', Buffer.from(key, 'utf8').toString('base64')],
    ['live DASHSCOPE_API_KEY (base64url)', Buffer.from(key, 'utf8').toString('base64url')],
    ['live DASHSCOPE_API_KEY (url-encoded)', encodeURIComponent(key)],
  ];
  const seen = new Set<string>();
  for (const [name, encoded] of encodings) {
    // Percent-encoding is a no-op for a key with no reserved characters; do not scan it twice.
    if (encoded.length < 8 || seen.has(encoded)) continue;
    seen.add(encoded);
    liveKeyRules.push({
      name,
      pattern: new RegExp(escape(encoded), 'g'),
      redact: true,
    });
  }
}

const allRules = [...rules, ...liveKeyRules];

/** Every encoded form of the live key. Used to redact matches found by ANY rule, not just its own. */
const liveMaterial: string[] = liveKeyRules.map((rule) =>
  rule.pattern.source.replace(/\\(.)/g, '$1'),
);

/**
 * Describe a match without becoming a leak. A real DashScope key is `sk-…`, so the generic rules
 * would happily echo it to a CI log; anything that overlaps live credential material is therefore
 * redacted whole, and everything else is masked down to a recognisable stub.
 */
function describe(match: string, redactWholeRule: boolean): string {
  if (redactWholeRule) return '<redacted — matched live credential material>';
  if (liveMaterial.some((value) => match.includes(value) || value.includes(match))) {
    return '<redacted — matched live credential material>';
  }
  if (match.startsWith('-----BEGIN')) return match;
  const head = match.slice(0, 6);
  return `${head}…<masked, ${match.length} chars>`;
}

// ---------------------------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------------------------

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (isEnvFile(entry)) continue;
    if (SKIPPED_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
    if (stat.size > MAX_FILE_BYTES) continue;
    out.push(full);
  }
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

const files: string[] = [];
collectFiles(REPO_ROOT, files);

const hits: Hit[] = [];
let scanned = 0;

for (const file of files) {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  // A NUL byte means this is binary, whatever the extension claims.
  if (source.includes('\0')) continue;
  scanned += 1;

  for (const rule of allRules) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      hits.push({
        rule: rule.name,
        file: relative(REPO_ROOT, file).split(sep).join('/'),
        line: lineOf(source, match.index),
        // Never echo credential material: the location is the whole report.
        evidence: describe(match[0], rule.redact),
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

console.log('secret scan  ·  working tree');
console.log(
  `  ${scanned} text file(s) scanned  ·  ${allRules.length} rule(s) active  ·  .env / .env.* excluded (gitignored, expected to hold the key)`,
);
console.log(
  liveKeyRules.length > 0
    ? `  DASHSCOPE_API_KEY is set in this environment: also scanning for its literal, base64, base64url and url-encoded forms (${liveKeyRules.length} encodings; the value is never printed)`
    : '  DASHSCOPE_API_KEY is not set in this environment: skipping live-key matching (export it to catch a committed real key)',
);
console.log(
  `  ${existsSync(join(REPO_ROOT, '.env')) ? '.env exists and was excluded' : 'no .env present'}`,
);
console.log(
  '  note: this scans the working tree only; committed content is covered by scripts/check-spec.sh',
);
console.log('');

if (hits.length > 0) {
  console.log(`✗ FAIL: ${hits.length} credential match${hits.length === 1 ? '' : 'es'} found.`);
  for (const hit of hits) {
    console.log(`    ${hit.file}:${hit.line}`);
    console.log(`      rule: ${hit.rule}`);
    console.log(`      match: ${hit.evidence}`);
  }
  console.log('');
  console.log('  Remove the credential, rotate it, and keep secrets in .env (gitignored) or the');
  console.log('  secret store. A key that reached a file has to be treated as already leaked.');
  process.exit(1);
}

console.log('✓ PASS: no credential material in the working tree.');
process.exit(0);
