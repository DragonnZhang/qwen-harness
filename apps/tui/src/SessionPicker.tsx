/**
 * The session picker and its resume switch (UI-10).
 *
 * `SessionPicker` lists the workspace's durable sessions and lets the user pick one — arrow keys
 * move the highlight, a number key jumps directly, Enter confirms, Esc quits. Every untrusted field
 * (the name, the first prompt) arrives as `SafeText` and is rendered inert; only the framing (the
 * title, the index, the counts, the key hints) is trusted chrome the component owns, exactly as the
 * approval dialog draws its own frame around an untrusted action.
 *
 * `SessionsApp` is the small stateful switch behind it: while no session is chosen it shows the
 * picker; once one is chosen it builds a REAL live controller resumed onto that thread
 * (`createLiveTurn({ resume })`, the same `createHarnessRuntime` path `run` uses) and hands off to
 * `LiveApp`. The picked thread's transcript re-renders and the session continues live.
 */

import { Box, Text, useApp, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useState } from 'react';

import type { ThreadId } from '@qwen-harness/protocol';

import { createLiveTurn } from './live-turn.ts';
import { LiveApp } from './live.tsx';
import type { LiveController } from './scripted-turn.ts';
import type { SessionRow } from './session-list.ts';
import type { StatusModel } from './types.ts';

export function SessionPicker({
  sessions,
  onSelect,
  onExit,
}: {
  sessions: readonly SessionRow[];
  onSelect: (threadId: ThreadId) => void;
  onExit: () => void;
}): ReactElement {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onExit();
      return;
    }
    if (sessions.length === 0) return;
    if (/^[1-9]$/.test(input)) {
      const row = sessions[Number(input) - 1];
      if (row !== undefined) onSelect(row.threadId);
      return;
    }
    if (key.upArrow) {
      setSelected((s) => (s + sessions.length - 1) % sessions.length);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % sessions.length);
      return;
    }
    if (key.return) {
      const row = sessions[selected];
      if (row !== undefined) onSelect(row.threadId);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Resume a session
      </Text>
      {sessions.length === 0 ? (
        <Text dimColor>No durable sessions in this workspace yet.</Text>
      ) : (
        sessions.map((row, i) => (
          <Box key={row.threadId} flexDirection="column">
            <Box>
              <Text inverse={i === selected} bold={i === selected}>
                {i === selected ? '▶ ' : '  '}[{i + 1}] {row.name}
              </Text>
              <Text dimColor>
                {' · '}
                {row.turns} {row.turns === 1 ? 'turn' : 'turns'}
                {' · '}
                {row.when}
              </Text>
            </Box>
            <Box>
              <Text dimColor>{'      '}</Text>
              <Text dimColor>{row.firstPrompt}</Text>
            </Box>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · Enter or 1-9 resume · Esc quit</Text>
      </Box>
    </Box>
  );
}

export function SessionsApp({
  mode,
  cwd,
  sessions,
}: {
  mode: StatusModel['mode'];
  cwd: string;
  sessions: readonly SessionRow[];
}): ReactElement {
  const { exit } = useApp();
  const [controller, setController] = useState<LiveController | null>(null);

  if (controller !== null) return <LiveApp controller={controller} />;

  return (
    <SessionPicker
      sessions={sessions}
      onSelect={(threadId) => {
        setController(createLiveTurn({ mode, cwd, resume: { threadId } }));
      }}
      onExit={() => {
        exit();
      }}
    />
  );
}
