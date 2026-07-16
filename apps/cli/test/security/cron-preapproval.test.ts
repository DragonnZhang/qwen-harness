import { NO_MANAGED_RESTRICTIONS, PolicyEngine } from '@qwen-harness/policy';
import type { ManagedPolicy, NormalizedAction, PolicyContext } from '@qwen-harness/policy';
import type { ActorId } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { preapprovalRule } from '../../src/scheduler.ts';

/**
 * An unattended cron claim runs ONLY the exact command its operator preapproved, and never escalates
 * (CR-06, S).
 *
 * A cron/daemon run has no interactive approval channel, so a scheduled command executes under the
 * "preapproved narrow rule" the operator implicitly authorized by scheduling exactly that command.
 * This proves the rule is narrow (a different command is NOT covered) and not a widening (a sealed
 * managed ceiling still refuses it).
 */

const engine = new PolicyEngine();
const CRON = { kind: 'cron' as const, id: 'act_cron00001' as ActorId };

const shell = (command: string): NormalizedAction => ({
  kind: 'shell',
  command,
  argv: command.split(' '),
  cwd: '/repo',
});

const ctx = (
  rules: PolicyContext['rules'],
  over: Partial<Pick<PolicyContext, 'profile' | 'managedPolicy'>> = {},
): PolicyContext => ({
  profile: over.profile ?? 'ask',
  managedPolicy: over.managedPolicy ?? NO_MANAGED_RESTRICTIONS,
  rules,
  grants: [],
  workspaceRoot: '/repo',
  homeDir: '/home',
  now: 0,
  actor: CRON,
});

describe('unattended cron execution is bounded to the preapproved command (CR-06, S)', () => {
  it('the exact scheduled command runs unattended; a DIFFERENT command does not', () => {
    const rule = preapprovalRule('git', ['status']);
    // The operator scheduled exactly `git status` — unattended, it needs no interactive approval.
    expect(engine.evaluate(shell('git status'), ctx([rule])).outcome).toBe('allow');
    // Any other command is NOT preapproved: it falls back to `ask`, which an unattended run cannot answer.
    expect(engine.evaluate(shell('git push --force'), ctx([rule])).outcome).not.toBe('allow');
  });

  it('the preapproval cannot loosen a sealed managed ceiling — a plan run still refuses the shell', () => {
    const rule = preapprovalRule('rm', ['-rf', '/tmp/x']);
    const plan: ManagedPolicy = { ...NO_MANAGED_RESTRICTIONS, maxProfile: 'plan' };
    const decision = engine.evaluate(
      shell('rm -rf /tmp/x'),
      ctx([rule], { profile: 'plan', managedPolicy: plan }),
    );
    // Even preapproved, `plan` forbids a shell — the preapproval is not an escalation path.
    expect(decision.outcome).not.toBe('allow');
  });
});
