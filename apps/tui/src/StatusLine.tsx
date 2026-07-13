/**
 * The status line and the persistent `yolo` danger banner (UI-06, UI-12, PS-05).
 *
 * The banner is trusted chrome ({@link YOLO_BANNER}) rendered in the LIVE region, redrawn on every
 * frame. It cannot be overwritten or spoofed by tool output for two reasons that compound: it is a
 * `TrustedChrome` value a `SafeText` can never be assigned to, and all transcript content has
 * crossed `sanitize`, so no tool byte can emit the cursor movement that would repaint over it.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { YOLO_BANNER } from '@qwen-harness/tui-kit';

import type { StatusModel } from './types.ts';

const MODE_COLOR: Record<StatusModel['mode'], string> = {
  plan: 'blue',
  ask: 'green',
  'auto-accept-edits': 'yellow',
  yolo: 'red',
};

export function StatusLine({ status }: { status: StatusModel }): ReactElement {
  return (
    <Box flexDirection="column">
      {status.mode === 'yolo' && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>
            {YOLO_BANNER}
          </Text>
        </Box>
      )}
      <Box>
        <Text dimColor>{status.cwd}</Text>
        <Text dimColor> · </Text>
        <Text color="cyan">{status.model}</Text>
        <Text dimColor> · </Text>
        <Text color={MODE_COLOR[status.mode]} bold>
          {status.mode}
        </Text>
        {status.contextTokens !== null && (
          <>
            <Text dimColor> · </Text>
            <Text dimColor>{status.contextTokens} ctx</Text>
          </>
        )}
        <Text dimColor> · </Text>
        {status.activity === 'busy' ? (
          <Text color="yellow">working…</Text>
        ) : (
          <Text dimColor>idle</Text>
        )}
      </Box>
    </Box>
  );
}
