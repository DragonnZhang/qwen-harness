/**
 * Credential isolation: a secret set in the PARENT environment must not be visible in the child.
 *
 * This is the concrete form of threat-model invariant 7. The provider key uses the same mechanism
 * as any other secret, so this test sets the real variable name in the parent and proves the child
 * cannot read it — and, separately, proves an arbitrary secret name is stripped too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CANARY_API_KEY } from '@qwen-harness/testkit';

import { BubblewrapBackend } from '../../src/backend.ts';
import { minimizeEnv } from '../../src/env.ts';
import { NODE, makeWorkspace, specFor, type Workspace } from './helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

// The variable name the whole product treats as the provider credential. Setting it in the parent
// and proving the child cannot see it is the point of the test.
const PROVIDER_KEY = 'DASHSCOPE_API_KEY';

describe('the provider credential does not cross into the sandbox', () => {
  it('DASHSCOPE_API_KEY set in the parent is NOT visible to the child', async () => {
    const parentEnv = { ...process.env, [PROVIDER_KEY]: CANARY_API_KEY };
    // The runtime always minimizes; the sandbox --clearenv is the second line of defense.
    const childEnv = minimizeEnv(parentEnv);
    expect(childEnv).not.toHaveProperty(PROVIDER_KEY);

    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          `const v = process.env['${PROVIDER_KEY}']; console.log(v === undefined ? 'ABSENT' : 'LEAKED:' + v);`,
        ],
        env: childEnv,
      }),
    );
    expect(result.stdout.trim()).toBe('ABSENT');
    expect(result.stdout).not.toContain('canary');
  });

  it('even a spec that FORGOT to minimize is protected by --clearenv', async () => {
    // Simulate a caller that passed only PATH but the parent process still has the secret set.
    process.env[PROVIDER_KEY] = CANARY_API_KEY;
    try {
      const result = await backend.run(
        specFor(ws, {
          command: NODE,
          args: [
            '-e',
            `console.log(process.env['${PROVIDER_KEY}'] === undefined ? 'ABSENT' : 'LEAKED')`,
          ],
          env: { PATH: '/usr/bin:/bin' },
        }),
      );
      expect(result.stdout.trim()).toBe('ABSENT');
    } finally {
      delete process.env[PROVIDER_KEY];
    }
  });

  it('the child sees ONLY the variables the spec named', async () => {
    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          // PWD is injected by node/libc from the cwd; the worker roots are injected by the backend.
          // Filter those three; what remains must be exactly what the spec named.
          "console.log(Object.keys(process.env).filter(k=>!['QH_WORKSPACE_ROOT','QH_SCRATCH_ROOT','PWD'].includes(k)).sort().join(','))",
        ],
        env: { PATH: '/usr/bin:/bin' },
      }),
    );
    expect(result.stdout.trim()).toBe('PATH');
  });
});
