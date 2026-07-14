/**
 * Unit + property tests for `ToolPipeline.decide` (TL-07).
 *
 * TL-07 is the no-bypass claim: a tool call passes schema → semantic → hard policy in THAT order, and
 * nothing runs a tool around the chain. `decide()` owns stages 1–3 (schema, semantic, policy) with no
 * host access, so it is the exact place to prove the ordering as a unit:
 *
 *   - a SCHEMA-invalid call is rejected BEFORE policy is ever consulted (the policy spy is untouched);
 *   - a policy `deny`/`ask`/`allow` verdict surfaces as `denied`/`needs-approval`/`approved`;
 *   - the `approved` action is derived from the VALIDATED arguments — the thing policy judged is the
 *     thing that would execute, so there is no gap to slip an unvalidated argument through.
 *
 * The policy engine is a spy so we can (a) assert it is NOT called on a schema failure and (b) script
 * each verdict. The real end-to-end pipeline (with the real policy, hooks, and sandbox) is exercised
 * in `apps/cli/test/integration/cli-run.test.ts` and `user-shell.test.ts`.
 */

import {
  NO_MANAGED_RESTRICTIONS,
  type PolicyContext,
  type PolicyEngine,
} from '@qwen-harness/policy';
import { ToolRegistry } from '@qwen-harness/tools-core';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS, registerBuiltins } from './index.ts';
import { ToolPipeline } from './pipeline.ts';

const CTX: PolicyContext = {
  profile: 'ask',
  managedPolicy: NO_MANAGED_RESTRICTIONS,
  rules: [],
  grants: [],
  workspaceRoot: '/ws',
  homeDir: '/home/nobody',
  now: 0,
  actor: { kind: 'model', id: 'act_model1' as never },
};

/** A scripted policy verdict. `decide` reads only outcome/source/reason/actionDigest/description. */
function verdict(outcome: 'allow' | 'deny' | 'ask') {
  return {
    outcome,
    reason: `scripted ${outcome}`,
    source: { stage: 'profile', id: 'ask' },
    actionDigest: 'digest_test',
    description: 'read a file',
    protectedMatches: [],
    trace: [],
  } as never;
}

function pipelineWith(evaluate: (...a: unknown[]) => unknown) {
  const policy = { evaluate: vi.fn(evaluate) } as unknown as PolicyEngine;
  const pipeline = new ToolPipeline({
    registry: registerBuiltins(new ToolRegistry(), BUILTIN_TOOLS),
    policy,
    client: new ToolWorkerClient(),
    builtins: BUILTIN_TOOLS,
  });
  return {
    pipeline,
    evaluateSpy: (policy as unknown as { evaluate: ReturnType<typeof vi.fn> }).evaluate,
  };
}

describe('ToolPipeline.decide — the no-bypass ordering (TL-07)', () => {
  it('rejects a SCHEMA-invalid call at `schema`, WITHOUT consulting policy', () => {
    const { pipeline, evaluateSpy } = pipelineWith(() => verdict('allow'));
    // read_file requires a `path`; an empty object fails the schema.
    const decision = pipeline.decide({
      callId: 'call_1',
      toolName: 'read_file',
      rawArguments: {},
      policyContext: CTX,
    });
    expect(decision.status).toBe('rejected');
    if (decision.status === 'rejected') expect(decision.stage).toBe('schema');
    // The security property: policy is NEVER reached for a malformed call.
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool without consulting policy', () => {
    const { pipeline, evaluateSpy } = pipelineWith(() => verdict('allow'));
    const decision = pipeline.decide({
      callId: 'call_1',
      toolName: 'not_a_tool',
      rawArguments: {},
      policyContext: CTX,
    });
    expect(decision.status).toBe('rejected');
    if (decision.status === 'rejected') expect(decision.stage).toBe('unknown-tool');
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('surfaces a policy `deny` as `denied`', () => {
    const { pipeline, evaluateSpy } = pipelineWith(() => verdict('deny'));
    const decision = pipeline.decide({
      callId: 'call_1',
      toolName: 'read_file',
      rawArguments: { path: 'src/x.ts' },
      policyContext: CTX,
    });
    expect(decision.status).toBe('denied');
    // Policy was consulted exactly once, with a validated action.
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a policy `ask` as `needs-approval`', () => {
    const { pipeline } = pipelineWith(() => verdict('ask'));
    const decision = pipeline.decide({
      callId: 'call_1',
      toolName: 'read_file',
      rawArguments: { path: 'src/x.ts' },
      policyContext: CTX,
    });
    expect(decision.status).toBe('needs-approval');
  });

  it('surfaces a policy `allow` as `approved`, carrying the VALIDATED arguments', () => {
    const { pipeline } = pipelineWith(() => verdict('allow'));
    const decision = pipeline.decide({
      callId: 'call_1',
      toolName: 'read_file',
      rawArguments: { path: 'src/x.ts', offsetLine: 0, limitLines: 10 },
      policyContext: CTX,
    });
    expect(decision.status).toBe('approved');
    if (decision.status === 'approved') {
      // The approved arguments are the PARSED ones (with schema defaults applied), not the raw input.
      expect(decision.arguments).toMatchObject({ path: 'src/x.ts' });
      expect(decision.tool.name).toBe('read_file');
    }
  });
});

describe('ToolPipeline.decide — schema gates policy for ANY input (TL-07 P)', () => {
  it('policy is consulted IFF validation passed — never for a rejected call', () => {
    fc.assert(
      fc.property(fc.anything(), (rawArguments) => {
        const { pipeline, evaluateSpy } = pipelineWith(() => verdict('allow'));
        const decision = pipeline.decide({
          callId: 'call_p',
          toolName: 'read_file',
          rawArguments,
          policyContext: CTX,
        });
        if (decision.status === 'rejected') {
          // A rejected call (schema/semantic) never reached policy — no bypass in EITHER direction.
          expect(evaluateSpy).not.toHaveBeenCalled();
        } else {
          // Anything that got past validation was judged by policy exactly once.
          expect(evaluateSpy).toHaveBeenCalledTimes(1);
        }
      }),
      { numRuns: 1500 },
    );
  });
});
