/**
 * The root Ink component (UI-01).
 *
 * Layout, top to bottom:
 *   1. `<Static>` — the COMPLETED transcript. Ink prints each completed row to scrollback exactly
 *      once and never touches it again, because `completedRows` returns stable frozen objects
 *      (tui-kit UI-01). This is what keeps a long transcript cheap: history is not re-rendered.
 *   2. the single ACTIVE streaming row, re-rendered on each delta;
 *   3. the status line (+ persistent yolo banner);
 *   4. the editor, or — when an approval is pending — the approval dialog.
 *
 * The app owns no agent-loop state. It reads items from an injected {@link RuntimeSource} and folds
 * them with `tui-kit`'s `buildTranscript`, so it renders identically whether driven by the live
 * runtime or a test fake.
 */

import { Box, Static, useApp } from 'ink';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { Item } from '@qwen-harness/protocol';
import { activeRow, buildTranscript, completedRows } from '@qwen-harness/tui-kit';
import type { EditorConfig } from '@qwen-harness/tui-kit';

import { ApprovalDialog } from './ApprovalDialog.tsx';
import { Editor } from './Editor.tsx';
import { StatusLine } from './StatusLine.tsx';
import { Transcript } from './Transcript.tsx';
import type { RuntimeSource } from './source.ts';
import type { ApprovalDecision, ApprovalPrompt, StatusModel } from './types.ts';

export interface AppProps {
  readonly source: RuntimeSource;
  readonly status: StatusModel;
  readonly approval?: ApprovalPrompt | null;
  readonly onSubmit?: (text: string) => void;
  readonly onInterrupt?: () => void;
  readonly onApprovalDecision?: (decision: ApprovalDecision) => void;
  readonly onCycleMode?: () => void;
  readonly editorConfig?: Partial<EditorConfig>;
  readonly history?: readonly string[];
}

export function App({
  source,
  status,
  approval = null,
  onSubmit,
  onInterrupt,
  onApprovalDecision,
  onCycleMode,
  editorConfig,
  history,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<readonly Item[]>(() => source.getItems());

  useEffect(() => {
    // Re-read on every change, then sync once in case an event fired before subscribe.
    const unsubscribe = source.subscribe(() => setItems(source.getItems()));
    setItems(source.getItems());
    return unsubscribe;
  }, [source]);

  const state = useMemo(() => buildTranscript(items), [items]);
  const completed = useMemo(() => completedRows(state), [state]);
  const active = activeRow(state);
  const dialogOpen = approval !== null;

  return (
    <Box flexDirection="column">
      <Static items={[...completed]}>{(row) => <Transcript key={row.id} row={row} />}</Static>
      {active !== null && <Transcript row={active} />}
      <StatusLine status={status} />
      {dialogOpen ? (
        <ApprovalDialog
          prompt={approval}
          onDecision={(decision) => onApprovalDecision?.(decision)}
        />
      ) : (
        <Editor
          onSubmit={(text) => onSubmit?.(text)}
          onInterrupt={() => onInterrupt?.()}
          onExit={exit}
          onCycleMode={onCycleMode}
          busy={status.activity === 'busy'}
          config={editorConfig}
          history={history}
          isActive={!dialogOpen}
        />
      )}
    </Box>
  );
}
