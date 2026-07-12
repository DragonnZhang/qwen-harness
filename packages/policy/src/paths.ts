/**
 * Protected paths and the glob engine that recognises them.
 *
 * The list is frozen in `docs/product/defaults.md`. Behavior per profile is also frozen:
 *
 *   plan               -> deny
 *   ask                -> require an EXACT grant (a broad allow-rule can never reach it)
 *   auto-accept-edits  -> require an EXACT grant
 *   yolo               -> whatever managed policy does not deny
 *
 * Two decisions here are worth stating out loud:
 *
 * 1. `system-path` (/etc, /proc, /sys, /dev, /boot, /root) is EXEMPT inside the workspace root.
 *    Opening a workspace is a deliberate user act, and a repository legitimately lives at
 *    /root/qwen-harness on this very host. Without the carve-out, every ordinary edit in that
 *    repository would classify as a protected /root write and `auto-accept-edits` would prompt for
 *    all of them — which trains users to click through prompts, the exact failure this list exists
 *    to prevent. The carve-out is narrow: only `system-path` is exempt. A `.env`, a `*.pem`, a
 *    `.git/**` write, or a `~/.ssh` file INSIDE the workspace stays protected.
 *
 * 2. Credential classes are protected for READS too, not only writes. Exfiltration is the threat;
 *    a read of `~/.aws/credentials` is the attack, and it never involves a write.
 */

export type ProtectedClass =
  | 'git-internal'
  | 'credential-file'
  | 'user-credential-store'
  | 'system-path'
  | 'daemon-socket'
  | 'metadata-endpoint';

/** Which accesses a rule covers. Credentials are read-protected; `.git/**` is write-protected. */
export type AccessKind = 'read' | 'write';

export interface ProtectedPathRule {
  readonly id: string;
  readonly class: ProtectedClass;
  /** `~` is expanded against the caller-supplied home directory (policy reads no environment). */
  readonly patterns: readonly string[];
  readonly appliesTo: readonly AccessKind[];
  /** Inside the workspace root, does this rule still apply? See the header comment. */
  readonly workspaceExempt: boolean;
  readonly why: string;
}

export interface ProtectedMatch {
  readonly ruleId: string;
  readonly class: ProtectedClass;
  readonly pattern: string;
  readonly target: string;
  readonly why: string;
}

const RW: readonly AccessKind[] = ['read', 'write'];
const W: readonly AccessKind[] = ['write'];

/** The complete list from docs/product/defaults.md. Adding to it is a policy change, not a fix. */
export const PROTECTED_PATH_RULES: readonly ProtectedPathRule[] = [
  {
    id: 'git-internal',
    class: 'git-internal',
    patterns: ['**/.git', '**/.git/**'],
    appliesTo: W,
    workspaceExempt: false,
    why: 'repository .git/** writes are reachable only through the dedicated validated Git tool',
  },
  {
    id: 'dotenv',
    class: 'credential-file',
    patterns: ['**/.env', '**/.env.*'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'environment files routinely hold live credentials',
  },
  {
    id: 'private-key-material',
    class: 'credential-file',
    patterns: ['**/*.pem', '**/*.key', '**/*.p12'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'private key material',
  },
  {
    id: 'package-registry-credentials',
    class: 'credential-file',
    patterns: ['**/.npmrc', '**/.pypirc'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'package registry tokens',
  },
  {
    id: 'netrc',
    class: 'credential-file',
    patterns: ['**/.netrc', '**/_netrc'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'machine credentials for arbitrary hosts',
  },
  {
    id: 'git-credentials',
    class: 'credential-file',
    patterns: ['**/.git-credentials', '**/.git/credentials', '**/.config/git/credentials'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'Git credential files hold plaintext forge tokens',
  },
  {
    id: 'ssh',
    class: 'user-credential-store',
    patterns: ['~/.ssh', '~/.ssh/**'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'SSH private keys and known-hosts',
  },
  {
    id: 'aws',
    class: 'user-credential-store',
    patterns: ['~/.aws', '~/.aws/**'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'AWS access keys',
  },
  {
    id: 'gcloud',
    class: 'user-credential-store',
    patterns: ['~/.config/gcloud', '~/.config/gcloud/**'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'Google Cloud application-default credentials',
  },
  {
    id: 'kube',
    class: 'user-credential-store',
    patterns: ['~/.kube', '~/.kube/**'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'Kubernetes cluster credentials',
  },
  {
    id: 'docker-config',
    class: 'user-credential-store',
    patterns: ['~/.docker/config.json'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'Docker registry auth',
  },
  {
    id: 'gh-hosts',
    class: 'user-credential-store',
    patterns: ['~/.config/gh/hosts.yml'],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'GitHub CLI OAuth token',
  },
  {
    id: 'xdg-credential-stores',
    class: 'user-credential-store',
    patterns: [
      '~/.config/containers/auth.json',
      '~/.local/share/keyrings/**',
      '~/.gnupg',
      '~/.gnupg/**',
    ],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'equivalent XDG credential stores',
  },
  {
    id: 'system-etc',
    class: 'system-path',
    patterns: ['/etc', '/etc/**'],
    appliesTo: RW,
    workspaceExempt: true,
    why: 'system configuration, including shadow and PAM',
  },
  {
    id: 'system-proc',
    class: 'system-path',
    patterns: ['/proc', '/proc/**'],
    appliesTo: RW,
    workspaceExempt: true,
    why: 'kernel and process introspection, including other processes’ environments',
  },
  {
    id: 'system-sys',
    class: 'system-path',
    patterns: ['/sys', '/sys/**'],
    appliesTo: RW,
    workspaceExempt: true,
    why: 'kernel object tree',
  },
  {
    id: 'system-dev',
    class: 'system-path',
    patterns: ['/dev', '/dev/**'],
    appliesTo: RW,
    workspaceExempt: true,
    why: 'raw devices',
  },
  {
    id: 'system-boot',
    class: 'system-path',
    patterns: ['/boot', '/boot/**'],
    appliesTo: RW,
    workspaceExempt: true,
    why: 'boot loader and kernel images',
  },
  {
    id: 'system-root-home',
    class: 'system-path',
    patterns: ['/root', '/root/**'],
    appliesTo: RW,
    workspaceExempt: true,
    why: "the root account's home directory",
  },
  {
    id: 'daemon-sockets',
    class: 'daemon-socket',
    patterns: [
      '/var/run/docker.sock',
      '/run/docker.sock',
      '/var/run/containerd/**',
      '/run/containerd/**',
      '/run/podman/**',
      '/var/run/podman/**',
      '/run/crio/**',
      '/run/user/*/podman/**',
      '/run/systemd/private',
    ],
    appliesTo: RW,
    workspaceExempt: false,
    why: 'a container/daemon socket is root-equivalent: it can mount the host and escape any sandbox',
  },
];

/**
 * Cloud instance metadata. Reachable over the network, not the filesystem, so it is matched on the
 * network host rather than on a path. 100.100.100.100 is the Alibaba Cloud endpoint, which matters
 * because the recorded target host IS an Alibaba ECS instance.
 */
export const METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.100',
  'fd00:ec2::254',
  '[fd00:ec2::254]',
];

/** The whole IPv4 link-local block is metadata-adjacent and never a legitimate agent target. */
const LINK_LOCAL_V4 = /^169\.254\.\d{1,3}\.\d{1,3}$/;

export function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase();
  return METADATA_HOSTS.includes(h) || LINK_LOCAL_V4.test(h);
}

// ---------------------------------------------------------------------------------------------
// Glob engine
// ---------------------------------------------------------------------------------------------

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(char: string): string {
  return char.replace(REGEXP_SPECIAL, '\\$&');
}

/**
 * `**` crosses path separators, `*` and `?` do not. Deliberately small: a full glob dialect would
 * be a second parser to get wrong, and every pattern in this file is one of three shapes.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` — zero or more leading directories.
          source += '(?:[^/]*/)*';
          i += 3;
          continue;
        }
        source += '.*';
        i += 2;
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    source += escapeLiteral(char);
    i += 1;
  }
  return new RegExp(source + '$');
}

const globCache = new Map<string, RegExp>();

export function matchGlob(pattern: string, value: string): boolean {
  let regexp = globCache.get(pattern);
  if (regexp === undefined) {
    regexp = globToRegExp(pattern);
    globCache.set(pattern, regexp);
  }
  return regexp.test(value);
}

/** Expand a leading `~` against an explicitly supplied home directory. No environment is read. */
export function expandHome(pattern: string, homeDir: string): string {
  if (pattern === '~') return homeDir;
  if (pattern.startsWith('~/')) return `${homeDir}${pattern.slice(1)}`;
  return pattern;
}

/** True when `path` is `root` itself or lives beneath it. Purely lexical: inputs are canonical. */
export function isWithin(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix);
}

export interface ProtectedLookupContext {
  readonly workspaceRoot: string;
  readonly homeDir: string;
}

/**
 * Classify one path. Returns EVERY rule that matches, not just the first: `doctor` should be able
 * to say "this is both a credential file and inside .git", and a caller that needs one reason can
 * take the first.
 */
export function classifyPath(
  path: string,
  access: AccessKind,
  ctx: ProtectedLookupContext,
): readonly ProtectedMatch[] {
  const matches: ProtectedMatch[] = [];
  const inWorkspace = isWithin(ctx.workspaceRoot, path);
  for (const rule of PROTECTED_PATH_RULES) {
    if (!rule.appliesTo.includes(access)) continue;
    if (rule.workspaceExempt && inWorkspace) continue;
    for (const pattern of rule.patterns) {
      const expanded = expandHome(pattern, ctx.homeDir);
      if (!matchGlob(expanded, path)) continue;
      matches.push({
        ruleId: rule.id,
        class: rule.class,
        pattern: expanded,
        target: path,
        why: rule.why,
      });
      break;
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------------------------
// Files whose EDIT is a privilege escalation even inside the workspace (PS-04).
// ---------------------------------------------------------------------------------------------

const EXECUTABLE_PATTERNS: readonly string[] = [
  '**/*.sh',
  '**/*.bash',
  '**/*.zsh',
  '**/*.fish',
  '**/*.ps1',
  '**/*.bat',
  '**/*.cmd',
  '**/*.exe',
  '**/*.run',
  '**/*.appimage',
];

const GIT_HOOK_PATTERNS: readonly string[] = [
  '**/.git/hooks/**',
  '**/.husky/**',
  '**/.pre-commit-config.yaml',
  '**/.githooks/**',
];

const PACKAGE_PATTERNS: readonly string[] = [
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/yarn.lock',
  '**/npm-shrinkwrap.json',
  '**/setup.py',
  '**/pyproject.toml',
  '**/requirements.txt',
  '**/Pipfile',
  '**/Cargo.toml',
  '**/Gemfile',
  '**/*.gemspec',
  '**/Makefile',
  '**/GNUmakefile',
  '**/build.gradle',
  '**/pom.xml',
];

export type SensitiveEditReason = 'executable' | 'git-hook' | 'package-manifest';

/**
 * `auto-accept-edits` auto-allows *ordinary* workspace files. Editing something that will later be
 * EXECUTED (a script, a Git hook, a package manifest with install scripts) converts a file edit
 * into arbitrary code execution, which is precisely the authority the profile did not grant.
 * Those keep asking.
 */
export function sensitiveEditReason(path: string, executable: boolean): SensitiveEditReason | null {
  if (executable) return 'executable';
  if (GIT_HOOK_PATTERNS.some((p) => matchGlob(p, path))) return 'git-hook';
  if (PACKAGE_PATTERNS.some((p) => matchGlob(p, path))) return 'package-manifest';
  if (EXECUTABLE_PATTERNS.some((p) => matchGlob(p, path))) return 'executable';
  return null;
}
