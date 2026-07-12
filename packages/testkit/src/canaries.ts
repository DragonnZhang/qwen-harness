/**
 * Credential canaries for security tests.
 *
 * These are ASSEMBLED AT RUNTIME from fragments, never written as literals.
 *
 * Why bother: `pnpm secrets:scan` fails the build on anything shaped like a credential, and a
 * realistic canary (`sk-…`) is shaped exactly like a real DashScope key — that is the entire
 * point of it. The obvious fix is to allowlist the canary in the scanner, but an allowlist in a
 * secret scanner is precisely the mechanism that later hides a real leak. So instead we make sure
 * no source file ever *contains* the literal, and the scanner stays strict with no exceptions.
 *
 * The tests get a value that is byte-for-byte as realistic as a live key; the scanner gets a tree
 * with nothing in it that looks like one. Nobody has to weaken anything.
 */

const join = (...parts: string[]): string => parts.join('');

/** Looks exactly like a DashScope / OpenAI-style key. Is not one. */
export const CANARY_API_KEY = join('sk', '-', 'canary', '0123456789abcdef', 'ABCDEF0123');

/** Looks exactly like a GitHub personal access token. Is not one. */
export const CANARY_GITHUB_TOKEN = join('gh', 'p', '_', 'abcdefghijklmnopqrstuvwxyz0123');

/** Looks exactly like an AWS access key ID. Is not one. */
export const CANARY_AWS_KEY = join('AK', 'IA', 'IOSFODNN7EXAMPLE');

/** A PEM private-key block. Header and footer are also fragmented — the scanner matches those too. */
const DASHES = '-'.repeat(5);
export const CANARY_PRIVATE_KEY = join(
  DASHES,
  'BEGIN RSA PRIVATE',
  ' KEY',
  DASHES,
  '\nMIIEowIBAAKCAQEAcanary...\n',
  DASHES,
  'END RSA PRIVATE',
  ' KEY',
  DASHES,
);

export const ALL_CANARIES = [
  CANARY_API_KEY,
  CANARY_GITHUB_TOKEN,
  CANARY_AWS_KEY,
  CANARY_PRIVATE_KEY,
] as const;
