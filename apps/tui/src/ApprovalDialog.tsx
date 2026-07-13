/**
 * The permission dialog (UI-05).
 *
 * It shows the ACTOR, the EXACT normalized action the approval binds to, the RISK, and the current
 * SANDBOX, then offers once / session / deny. The action is untrusted `SafeText`, rendered inert in
 * its own column so it can never forge the dialog chrome around it. There is no hidden tab: every
 * parameter the decision depends on is on screen at once.
 *
 * Esc denies (the safe default). 1/2/3 pick directly; arrows move the highlight and Enter confirms.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useState } from 'react';

import type { ApprovalDecision, ApprovalPrompt } from './types.ts';

const CHOICES: readonly { readonly id: ApprovalDecision; readonly label: string }[] = [
  { id: 'once', label: 'allow once' },
  { id: 'session', label: 'allow this session' },
  { id: 'deny', label: 'deny' },
];

const RISK_COLOR: Record<ApprovalPrompt['risk'], string> = {
  low: 'green',
  medium: 'yellow',
  high: 'red',
};

export function ApprovalDialog({
  prompt,
  onDecision,
}: {
  prompt: ApprovalPrompt;
  onDecision: (decision: ApprovalDecision) => void;
}): ReactElement {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onDecision('deny');
      return;
    }
    if (input === '1') return onDecision('once');
    if (input === '2') return onDecision('session');
    if (input === '3') return onDecision('deny');
    if (key.leftArrow || key.upArrow) {
      setSelected((s) => (s + CHOICES.length - 1) % CHOICES.length);
      return;
    }
    if (key.rightArrow || key.downArrow || key.tab) {
      setSelected((s) => (s + 1) % CHOICES.length);
      return;
    }
    if (key.return) {
      onDecision(CHOICES[selected]?.id ?? 'deny');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Approval required
      </Text>
      <Box>
        <Box width={9} flexShrink={0}>
          <Text dimColor>actor</Text>
        </Box>
        <Text>{prompt.actor}</Text>
      </Box>
      <Box>
        <Box width={9} flexShrink={0}>
          <Text dimColor>action</Text>
        </Box>
        <Text bold>{prompt.action}</Text>
      </Box>
      <Box>
        <Box width={9} flexShrink={0}>
          <Text dimColor>risk</Text>
        </Box>
        <Text color={RISK_COLOR[prompt.risk]}>{prompt.risk}</Text>
      </Box>
      <Box>
        <Box width={9} flexShrink={0}>
          <Text dimColor>sandbox</Text>
        </Box>
        <Text>{prompt.isolation}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {CHOICES.map((choice, i) => (
          <Text key={choice.id} inverse={i === selected}>
            {i === selected ? '▶ ' : '  '}[{i + 1}] {choice.label}
          </Text>
        ))}
      </Box>
      <Text dimColor>Esc denies</Text>
    </Box>
  );
}
