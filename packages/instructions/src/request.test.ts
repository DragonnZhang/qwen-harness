import { describe, expect, it } from 'vitest';

import {
  attachInstructions,
  buildRequestInstructions,
  instructionStringForRequest,
} from './request.ts';
import { resolveInstructions, type DiscoveredInstruction } from './resolution.ts';

function loaded(extra: DiscoveredInstruction[] = []) {
  return resolveInstructions([
    {
      path: '/repo/AGENTS.md',
      scope: 'repo-root',
      dir: '/repo',
      depth: 2,
      rawText: 'always run the tests',
      pathScope: null,
    },
    ...extra,
  ]);
}

describe('IN-10: instruction text is on every request', () => {
  it('appears in the request payload the helper builds', () => {
    const text = instructionStringForRequest(loaded(), { systemPrompt: 'SYS' });
    expect(text).toContain('SYS');
    expect(text).toContain('always run the tests');

    const request = attachInstructions({ model: 'qwen3.7-max', input: [] }, text);
    expect(request.instructions).toBe(text);
    expect(request.instructions).toContain('always run the tests');
  });

  it('sends identical text whether or not the transport claims to inherit it', () => {
    const inherits = buildRequestInstructions(loaded(), {
      systemPrompt: 'SYS',
      transportInheritsInstructions: true,
    });
    const fresh = buildRequestInstructions(loaded(), {
      systemPrompt: 'SYS',
      transportInheritsInstructions: false,
    });
    // Cache optimization must not change behavior: same text, always marked sent.
    expect(inherits.instructions).toBe(fresh.instructions);
    expect(inherits.sent).toBe(true);
    expect(fresh.sent).toBe(true);
    expect(inherits.transportInheritsInstructions).toBe(true);
  });

  it('includes a path-scoped instruction only when its path is accessed', () => {
    const l = loaded([
      {
        path: '/repo/apps/AGENTS.md',
        scope: 'nested',
        dir: '/repo/apps',
        depth: 3,
        rawText: 'apps-only rule',
        pathScope: '/repo/apps',
      },
    ]);
    expect(instructionStringForRequest(l, {})).not.toContain('apps-only rule');
    expect(instructionStringForRequest(l, { accessedPaths: ['/repo/apps/x.ts'] })).toContain(
      'apps-only rule',
    );
  });
});
