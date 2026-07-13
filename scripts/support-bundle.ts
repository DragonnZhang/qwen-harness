/**
 * PK-04 — the support bundle.
 *
 * Produces `dist/release/support-bundle-<timestamp>.tar.gz`: the diagnostics an operator can attach
 * to a bug report without having to read every byte first to check that they are not about to email
 * us their API key.
 *
 * That last clause is the entire design constraint. A support bundle is, by construction, a pile of
 * the most sensitive text on the machine — config files, logs, environment, command lines — and it
 * is collected by someone who is already having a bad day and will not audit it. So:
 *
 *   1. ENVIRONMENT VALUES ARE NEVER COLLECTED. Only variable NAMES, and a presence boolean for the
 *      credential. There is no allowlist of "safe" variables to get wrong.
 *
 *   2. EVERY byte that does get collected goes through `scrub()` before it is written — not just the
 *      files we think are risky. Scrubbing at the single choke point means a future collector cannot
 *      forget to scrub; it is not possible to add unscrubbed content to the bundle through this API.
 *
 *   3. The scrubber ALSO redacts the live values of any environment variable whose NAME looks like a
 *      secret. Pattern-matching alone catches `sk-…`-shaped keys; it does not catch a bearer token
 *      that happens to look like a UUID and got logged. Knowing the actual value is the only way.
 *
 *   4. After the bundle is assembled, it is RE-SCANNED and the write is ABORTED if anything still
 *      matches. A scrubber with a bug fails loudly rather than shipping the secret it missed.
 *
 * `packaging/test/support-bundle.test.ts` proves this with the testkit canaries — realistic
 * credential material that is not a real credential — planted in every collected surface.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = join(REPO_ROOT, 'dist', 'release');

// ---------------------------------------------------------------------------------------------
// The scrubber
// ---------------------------------------------------------------------------------------------

/**
 * Credential shapes. Deliberately the SAME rules the repo's own secret scanner enforces
 * (`scripts/secret-scan.ts`), because a bundle that leaks something the scanner would have failed
 * the build over is the worst of both worlds.
 */
const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'api-key', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'github-token', pattern: /gh[opusr]_[A-Za-z0-9]{20,}/g },
  { name: 'aws-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  {
    name: 'private-key',
    pattern:
      /-----BEGIN (?:RSA|EC|OPENSSH|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g,
  },
  { name: 'bearer-token', pattern: /(?<=[Bb]earer\s)[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: 'basic-auth-url', pattern: /(?<=:\/\/)[^/\s:@]+:[^/\s:@]+(?=@)/g },
];

/** An env var whose NAME says it holds a secret. Its VALUE is redacted wherever it appears. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Values short enough that redacting them everywhere would corrupt the bundle into uselessness. */
const MIN_SECRET_VALUE_LENGTH = 8;

export interface ScrubResult {
  readonly text: string;
  readonly redactions: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect the literal values worth redacting from an environment: every variable whose name looks
 * like a secret, plus its base64 form — a key that survived into a log through an `Authorization`
 * header is often base64 by the time it lands there.
 */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    out.push(trimmed);
    out.push(Buffer.from(trimmed, 'utf8').toString('base64'));
    out.push(Buffer.from(trimmed, 'utf8').toString('base64url'));
  }
  // Longest first: redacting a substring before its superstring would leave the tail exposed.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/**
 * Remove credential material from `text`. `literals` are exact values known to be secret (from
 * `secretsFromEnv`); they are redacted BEFORE the shape rules, because an exact match is the
 * stronger signal and its marker should name the variable class, not a guessed shape.
 */
export function scrub(text: string, literals: readonly string[] = []): ScrubResult {
  let out = text;
  let redactions = 0;

  for (const literal of literals) {
    if (literal.length < MIN_SECRET_VALUE_LENGTH) continue;
    const re = new RegExp(escapeRegExp(literal), 'g');
    out = out.replace(re, () => {
      redactions += 1;
      return '«redacted: environment secret»';
    });
  }

  for (const { name, pattern } of SECRET_PATTERNS) {
    // Fresh RegExp per call: a module-level /g regex carries `lastIndex` between calls and would
    // silently skip matches on the second file. This has bitten every codebase that shares one.
    const re = new RegExp(pattern.source, pattern.flags);
    out = out.replace(re, () => {
      redactions += 1;
      return `«redacted: ${name}»`;
    });
  }

  return { text: out, redactions };
}

/** The bundle's own final gate: does any credential shape survive anywhere in it? */
export function findResidualSecrets(
  text: string,
  literals: readonly string[] = [],
): { rule: string; index: number }[] {
  const hits: { rule: string; index: number }[] = [];
  for (const literal of literals) {
    if (literal.length < MIN_SECRET_VALUE_LENGTH) continue;
    const index = text.indexOf(literal);
    if (index !== -1) hits.push({ rule: 'environment secret (literal)', index });
  }
  for (const { name, pattern } of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of text.matchAll(re)) hits.push({ rule: name, index: m.index });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

export interface BundleFile {
  readonly path: string;
  readonly content: string;
}

export interface CollectOptions {
  readonly env: Record<string, string | undefined>;
  readonly homeDir: string;
  readonly projectRoot: string;
  /** Overridable so the tests can point at a fixture state dir instead of the real one. */
  readonly stateDir?: string;
  /** Overridable so the tests do not depend on this host having a built CLI. */
  readonly runCommand?: (cmd: string, args: readonly string[]) => string;
}

function safeRun(cmd: string, args: readonly string[]): string {
  try {
    return execFileSync(cmd, [...args], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return `<command failed: ${cmd} ${args.join(' ')}>\n${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
  }
}

/** The last `maxBytes` of a file — a log's tail is where the failure is. */
function tail(path: string, maxBytes = 256 * 1024): string {
  const size = statSync(path).size;
  const buf = readFileSync(path);
  return size <= maxBytes
    ? buf.toString('utf8')
    : `<truncated: showing the last ${String(maxBytes)} of ${String(size)} bytes>\n${buf.subarray(size - maxBytes).toString('utf8')}`;
}

/**
 * Build the bundle's file list. Pure with respect to secrets: nothing here is written anywhere; the
 * caller scrubs. Every collector returns TEXT, so there is exactly one type of thing to scrub.
 */
export function collect(options: CollectOptions): BundleFile[] {
  const run = options.runCommand ?? safeRun;
  const files: BundleFile[] = [];
  const stateDir = options.stateDir ?? join(options.homeDir, '.qwen-harness');

  // --- host -------------------------------------------------------------------------------
  const host = [
    `hostname (hashed): ${hostname().length > 0 ? 'present' : 'unknown'}`,
    `platform: ${process.platform} ${process.arch}`,
    `node: ${process.version}`,
    `kernel: ${run('uname', ['-a']).trim()}`,
    '',
    '--- /etc/os-release ---',
    existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '<absent>',
    '--- tool versions ---',
    ...['node', 'pnpm', 'git', 'cc', 'bwrap'].map(
      (t) =>
        `${t}: ${run('bash', ['-c', `command -v ${t} >/dev/null 2>&1 && ${t} --version 2>&1 | head -1 || echo ABSENT`]).trim()}`,
    ),
  ].join('\n');
  files.push({ path: 'host.txt', content: `${host}\n` });

  // --- environment: NAMES ONLY -------------------------------------------------------------
  // The values are not collected, not scrubbed, not truncated — they are never read into the
  // bundle at all. There is no code path here that could leak one.
  const names = Object.keys(options.env).sort();
  const credentialPresent =
    typeof options.env['DASHSCOPE_API_KEY'] === 'string' &&
    options.env['DASHSCOPE_API_KEY'].length > 0;
  const envReport = [
    'Environment variable NAMES only. No value from the environment is ever collected.',
    '',
    `DASHSCOPE_API_KEY: ${credentialPresent ? 'present' : 'absent'}  (presence only; the value is not read)`,
    '',
    `${String(names.length)} variables set:`,
    ...names.map((n) => `  ${n}`),
  ].join('\n');
  files.push({ path: 'environment.txt', content: `${envReport}\n` });

  // --- sandbox -----------------------------------------------------------------------------
  const sandbox = [
    `bwrap: ${run('bash', ['-c', 'command -v bwrap || echo ABSENT']).trim()}`,
    `user.max_user_namespaces: ${run('bash', ['-c', 'cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unreadable']).trim()}`,
    `apparmor_restrict_unprivileged_userns: ${run('bash', ['-c', 'cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent']).trim()}`,
    '',
    '--- functional probe: bwrap --unshare-all /bin/echo ok ---',
    run('bash', [
      '-c',
      'bwrap --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 --proc /proc --dev /dev --unshare-all --die-with-parent /bin/echo ok 2>&1 || true',
    ]).trim(),
  ].join('\n');
  files.push({ path: 'sandbox.txt', content: `${sandbox}\n` });

  // --- config (scrubbed like everything else) ----------------------------------------------
  const xdg = options.env['XDG_CONFIG_HOME'];
  const configBase = xdg !== undefined && xdg.length > 0 ? xdg : join(options.homeDir, '.config');
  const configCandidates = [
    join(configBase, 'qwen-harness', 'config.json'),
    join('/etc', 'qwen-harness', 'managed.json'),
    join(options.projectRoot, '.qwen-harness', 'config.json'),
    join(options.projectRoot, '.qwen-harness', 'config.local.json'),
  ];
  const configParts: string[] = [];
  for (const path of configCandidates) {
    configParts.push(`--- ${path} ---`);
    configParts.push(existsSync(path) ? readFileSync(path, 'utf8') : '<absent>');
    configParts.push('');
  }
  files.push({ path: 'config.txt', content: `${configParts.join('\n')}\n` });

  // --- doctor ------------------------------------------------------------------------------
  const cliBin = join(options.projectRoot, 'apps', 'cli', 'dist', 'bin.js');
  files.push({
    path: 'doctor.txt',
    content: existsSync(cliBin)
      ? run('node', [cliBin, 'doctor'])
      : '<the CLI is not built in this tree; run `pnpm build` and re-collect>\n',
  });

  // --- state dir: an inventory, plus the tail of any log ------------------------------------
  const stateParts: string[] = [`state directory: ${stateDir}`, ''];
  if (existsSync(stateDir)) {
    const entries: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else entries.push(`  ${String(st.size).padStart(10)}  ${relative(stateDir, full)}`);
      }
    };
    walk(stateDir);
    stateParts.push(`${String(entries.length)} files:`, ...entries, '');
    for (const name of readdirSync(stateDir).sort()) {
      if (!name.endsWith('.log')) continue;
      stateParts.push(`--- tail of ${name} ---`, tail(join(stateDir, name)), '');
    }
  } else {
    stateParts.push(
      '<absent — the harness has not run on this host, or uses a different state dir>',
    );
  }
  files.push({ path: 'state.txt', content: `${stateParts.join('\n')}\n` });

  return files;
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

export class SupportBundleLeakError extends Error {
  override readonly name = 'SupportBundleLeakError';
}

export interface BundleResult {
  readonly files: readonly BundleFile[];
  readonly redactions: number;
}

/**
 * Scrub every collected file, then verify the result. Returns the bundle that is SAFE to write.
 * Throws `SupportBundleLeakError` if anything credential-shaped survived — the caller must not
 * catch that and write anyway, and nothing in this file gives it the option.
 */
export function assemble(files: readonly BundleFile[], literals: readonly string[]): BundleResult {
  const scrubbed: BundleFile[] = [];
  let redactions = 0;
  for (const file of files) {
    const result = scrub(file.content, literals);
    redactions += result.redactions;
    scrubbed.push({ path: file.path, content: result.text });
  }

  // The final gate. Re-scan the SCRUBBED text — if the scrubber has a bug, this is where we find
  // out, and we find out by refusing to produce a bundle rather than by a user's key on a mailing
  // list. `«redacted: …»` markers cannot themselves match a rule, so a clean bundle passes.
  const residual: string[] = [];
  for (const file of scrubbed) {
    for (const hit of findResidualSecrets(file.content, literals)) {
      residual.push(`${file.path}: ${hit.rule} at offset ${String(hit.index)}`);
    }
  }
  if (residual.length > 0) {
    throw new SupportBundleLeakError(
      `refusing to write a support bundle: ${String(residual.length)} credential match(es) survived scrubbing:\n` +
        residual.map((r) => `    ${r}`).join('\n') +
        '\n  This is a bug in the scrubber. The bundle was NOT written.',
    );
  }

  return { files: scrubbed, redactions };
}

export function writeBundle(bundle: BundleResult, outPath: string): void {
  const staging = `${outPath}.d`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const file of bundle.files) {
    writeFileSync(join(staging, file.path), file.content, 'utf8');
  }
  writeFileSync(
    join(staging, 'README.txt'),
    [
      'qwen-harness support bundle',
      '',
      'Every file in this bundle has been scrubbed of credential material, and the bundle was',
      're-scanned after scrubbing — it would not have been written if anything matched.',
      '',
      'Environment VALUES were never collected: environment.txt lists variable names only.',
      `Redactions applied: ${String(bundle.redactions)} (each appears as «redacted: …»).`,
      '',
      'If you see anything in here you would rather not send, delete the file and say so in the',
      'issue — the bundle is a convenience, not a requirement.',
      '',
    ].join('\n'),
    'utf8',
  );
  execFileSync(
    'bash',
    [
      '-c',
      `tar --sort=name --owner=0 --group=0 --numeric-owner -czf ${JSON.stringify(outPath)} -C ${JSON.stringify(staging)} .`,
    ],
    { encoding: 'utf8' },
  );
  rmSync(staging, { recursive: true, force: true });
}

export function main(): number {
  mkdirSync(OUT_DIR, { recursive: true });
  const env = process.env;
  const literals = secretsFromEnv(env);

  // Count the VARIABLES, not the encodings of their values. `secretsFromEnv` emits several encoded
  // forms per variable and dedupes across them, so dividing its length by a constant is a guess
  // that goes wrong the moment two variables share a value.
  const secretVarNames = Object.entries(env)
    .filter(
      ([name, value]) => value !== undefined && value.trim().length >= 8 && SECRET_NAME.test(name),
    )
    .map(([name]) => name);

  console.log('support bundle');
  console.log(
    `  ${String(secretVarNames.length)} secret-named environment variable(s) will have their VALUES redacted wherever`,
  );
  console.log(`  they appear: ${secretVarNames.join(', ') || '(none set)'}`);
  console.log('  (the names are safe to print; the values never enter the bundle at all)');

  const files = collect({
    env,
    homeDir: homedir(),
    projectRoot: REPO_ROOT,
  });

  let bundle: BundleResult;
  try {
    bundle = assemble(files, literals);
  } catch (e) {
    console.error('');
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(OUT_DIR, `support-bundle-${stamp}.tar.gz`);
  writeBundle(bundle, out);

  console.log('');
  for (const file of bundle.files) {
    console.log(`  · ${file.path.padEnd(18)} ${String(file.content.length).padStart(8)} bytes`);
  }
  console.log('');
  console.log(`  ${String(bundle.redactions)} redaction(s) applied`);
  console.log(`  ✓ ${relative(REPO_ROOT, out)}`);
  console.log('    scrubbed, re-scanned, and safe to attach to an issue.');
  return 0;
}

// Exact path comparison: the packaging tests import `collect`/`assemble`/`scrub` from here, and
// must not trigger a real bundle of the developer's actual machine on import.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
