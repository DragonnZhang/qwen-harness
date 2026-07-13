import { sanitizeText } from '@qwen-harness/protocol';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '@qwen-harness/runtime';

/**
 * The CLI's approval channel (PS-03, PS-09).
 *
 * Three rules, and they are the whole point:
 *
 *   1. The prompt shows the EXACT normalized action policy judged — not the tool name, not a
 *      paraphrase. The approval binds to that action's digest, so approving `rm -rf build` does not
 *      approve `rm -rf /`.
 *   2. The action text came from the model. It is sanitized before it reaches the terminal, so a
 *      tool argument cannot repaint the screen to forge a dialog the user then "confirms"
 *      (threat model: approval confusion).
 *   3. Silence is never consent. EOF, a closed stdin, or no channel at all yields `deferred`: the
 *      turn stays `awaiting-approval` in the durable log and a human can answer it later. Nothing
 *      auto-approves, ever (defaults.md).
 */

export interface PromptIo {
  readonly stdout: (line: string) => void;
  /** Reads one line from the operator. `null` means the channel is closed — never an approval. */
  readonly readLine: (prompt: string) => Promise<string | null>;
}

const RISK_LABEL: Record<ApprovalRequest['risk'], string> = {
  low: 'low',
  medium: 'MEDIUM',
  high: 'HIGH',
};

export function interactiveApprovalGate(io: PromptIo): ApprovalGate {
  return {
    request: async (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> => {
      if (signal.aborted) {
        return { kind: 'deferred', reason: 'the turn was cancelled before it could be approved' };
      }

      const action = sanitizeText(request.description, 'model');
      const tool = sanitizeText(request.toolName, 'model');
      io.stdout('');
      io.stdout(`  permission required  (risk: ${RISK_LABEL[request.risk]})`);
      io.stdout(`  tool:   ${tool}`);
      io.stdout(`  action: ${action}`);
      io.stdout(`  why:    ${sanitizeText(request.reason, 'model')}`);

      const answer = await io.readLine('  approve? [y]es once / [s]ession / [N]o: ');
      if (answer === null) {
        return {
          kind: 'deferred',
          reason: 'no interactive input is available; the turn is left awaiting approval',
        };
      }

      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes' || normalized === 'once') {
        return { kind: 'approved', scope: 'once' };
      }
      if (normalized === 's' || normalized === 'session') {
        return { kind: 'approved', scope: 'session' };
      }
      // Anything else — including an empty line — is a refusal. Deny by default.
      return {
        kind: 'denied',
        reason: normalized.length === 0 ? 'no answer given' : 'the operator declined',
      };
    },
  };
}
