/**
 * Render one {@link TranscriptRow} (UI-01, UI-02).
 *
 * The view models from `tui-kit` have already drawn the trust boundary: every content field is
 * `SafeText` (inert), and each row carries a `TrustedChrome` label. This component keeps the two
 * VISUALLY distinct — the label is a coloured/bold chrome tag in its own column, the content is
 * plain, unstyled-by-origin text to its right — so tool output can never masquerade as our framing.
 *
 * Markdown, code, inline code, links, and unified diffs all render through the `tui-kit`
 * projections; the renderer only chooses a COLOUR from structure (a diff line's `kind`, a span's
 * `kind`), never by re-parsing untrusted text.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { SafeText } from '@qwen-harness/protocol';
import { segmentMarkdown } from '@qwen-harness/tui-kit';
import type { DiffRow, ParsedDiff, TranscriptRow, TrustedChrome } from '@qwen-harness/tui-kit';

/** How many lines of a bounded preview (tool result / shell output) to show before eliding. */
const PREVIEW_LINES = 12;

/** A trusted chrome label in its own coloured column, kept apart from untrusted content. */
function Label({ text, color }: { text: TrustedChrome; color: string }): ReactElement {
  return (
    <Box flexShrink={0} marginRight={1}>
      <Text color={color} bold>
        {text}
      </Text>
    </Box>
  );
}

/** Model text as Markdown: paragraphs, fenced code, inline code, and links (UI-02). */
function Markdown({ text }: { text: SafeText }): ReactElement {
  const blocks = segmentMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, bi) => {
        if (block.kind === 'code') {
          return (
            <Box
              key={bi}
              flexDirection="column"
              paddingLeft={1}
              borderStyle="round"
              borderColor="gray"
            >
              {block.language !== null && <Text dimColor>{block.language}</Text>}
              <Text color="greenBright">{block.text === '' ? ' ' : block.text}</Text>
            </Box>
          );
        }
        return (
          <Text key={bi}>
            {block.spans.map((span, si) => {
              if (span.kind === 'code')
                return (
                  <Text key={si} color="yellow">
                    {span.text}
                  </Text>
                );
              if (span.kind === 'link')
                return (
                  <Text key={si} color="blue" underline>
                    {span.text}
                  </Text>
                );
              if (span.kind === 'unsafe-link')
                // A model link whose scheme is unsafe: rendered as PLAIN text, never clickable.
                return <Text key={si}>{span.text}</Text>;
              return <Text key={si}>{span.text}</Text>;
            })}
          </Text>
        );
      })}
    </Box>
  );
}

/** A unified diff: add lines green, remove lines red, headers cyan (UI-02). */
function Diff({ diff }: { diff: ParsedDiff }): ReactElement {
  return (
    <Box flexDirection="column">
      {diff.files.map((file, fi) => (
        <Box key={fi} flexDirection="column">
          {(file.oldPath !== null || file.newPath !== null) && (
            <Text color="cyan" bold>
              {file.oldPath ?? '/dev/null'} {'->'} {file.newPath ?? '/dev/null'}
            </Text>
          )}
          {file.hunks.map((hunk, hi) => (
            <Box key={hi} flexDirection="column">
              <Text color="magenta">{hunk.header}</Text>
              {hunk.lines.map((dl, li) => {
                if (dl.kind === 'add')
                  return (
                    <Text key={li} color="green">
                      +{dl.text}
                    </Text>
                  );
                if (dl.kind === 'remove')
                  return (
                    <Text key={li} color="red">
                      -{dl.text}
                    </Text>
                  );
                if (dl.kind === 'header')
                  return (
                    <Text key={li} dimColor>
                      {dl.text}
                    </Text>
                  );
                return <Text key={li}> {dl.text}</Text>;
              })}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/** Show at most {@link PREVIEW_LINES} lines of a bounded preview, eliding the remainder. */
function BoundedPreview({ text }: { text: SafeText }): ReactElement {
  const lines = text.split('\n');
  const shown = lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column">
      <Text>{shown.join('\n')}</Text>
      {hidden > 0 && <Text dimColor>… {hidden} more line(s)</Text>}
    </Box>
  );
}

/**
 * Render a single row. Every branch pairs a trusted-chrome {@link Label} with inert `SafeText`
 * content, so the two sides of the boundary are always visually separable.
 */
export function Transcript({ row }: { row: TranscriptRow }): ReactElement {
  switch (row.kind) {
    case 'user':
      return (
        <Box>
          <Label text={row.label} color="green" />
          <Markdown text={row.text} />
        </Box>
      );

    case 'assistant':
      return (
        <Box>
          <Label text={row.label} color="cyan" />
          <Box flexDirection="column">
            <Markdown text={row.text} />
            {row.streaming && <Text dimColor>▍</Text>}
          </Box>
        </Box>
      );

    case 'reasoning-summary':
      return (
        <Box>
          <Label text={row.label} color="magenta" />
          <Text italic dimColor>
            {row.text}
          </Text>
        </Box>
      );

    case 'tool-call':
      return (
        <Box>
          <Label text={row.label} color="yellow" />
          <Text>
            <Text bold>{row.toolName}</Text> <Text dimColor>{row.argsPreview}</Text>
          </Text>
        </Box>
      );

    case 'tool-result':
      return (
        <Box>
          <Label text={row.label} color={row.ok ? 'green' : 'red'} />
          <Box flexDirection="column">
            <Text dimColor>
              {row.toolName} · {row.ok ? 'ok' : 'error'} · {row.durationMs}ms
              {row.errorCategory !== null ? ` · ${row.errorCategory}` : ''}
            </Text>
            <BoundedPreview text={row.preview} />
            {row.truncated && <Text dimColor>(truncated)</Text>}
          </Box>
        </Box>
      );

    case 'diff':
      return (
        <Box>
          <Label text={(row as DiffRow).label} color="yellow" />
          <Box flexDirection="column">
            <Text dimColor>{row.toolName}</Text>
            <Diff diff={row.diff} />
          </Box>
        </Box>
      );

    case 'error':
      return (
        <Box>
          <Label text={row.label} color="red" />
          <Box flexDirection="column">
            <Text color="red">
              {row.category}: {row.message}
            </Text>
            <Text dimColor>
              {row.retryable ? 'retryable' : 'not retryable'}
              {row.requestId !== null ? ` · request ${row.requestId}` : ''}
            </Text>
          </Box>
        </Box>
      );

    case 'usage':
      return (
        <Box>
          <Label text={row.label} color="gray" />
          <Text dimColor>
            in {row.inputTokens ?? '?'} · out {row.outputTokens ?? '?'} · total{' '}
            {row.totalTokens ?? '?'}
            {row.reasoningTokens !== null ? ` · reasoning ${row.reasoningTokens}` : ''}
            {row.cachedInputTokens !== null ? ` · cached ${row.cachedInputTokens}` : ''}
          </Text>
        </Box>
      );

    case 'progress':
      return (
        <Box>
          <Label text={row.label} color="gray" />
          <Text dimColor>
            {row.detail ?? 'working'}
            {row.tokens !== null ? ` · ${row.tokens} tokens` : ''}
          </Text>
        </Box>
      );

    case 'approval':
      return (
        <Box>
          <Label text={row.label} color="yellow" />
          <Text dimColor>
            {row.decision}
            {row.scope !== null ? ` (${row.scope})` : ''} · {row.normalizedAction}
            {row.actorLabel !== null ? ` · ${row.actorLabel}` : ''}
          </Text>
        </Box>
      );

    case 'compaction':
      return (
        <Box>
          <Label text={row.label} color="gray" />
          <Box flexDirection="column">
            <Text dimColor>
              {row.trigger} · {row.tokensBefore} {'->'} {row.tokensAfter} tokens
            </Text>
            <Text dimColor>{row.summary}</Text>
          </Box>
        </Box>
      );

    case 'user-shell':
      return (
        <Box>
          <Label text={row.label} color="cyan" />
          <Box flexDirection="column">
            <Text bold>$ {row.command}</Text>
            <BoundedPreview text={row.output} />
            <Text dimColor>
              exit {row.exitCode ?? '?'}
              {row.truncated ? ' · truncated' : ''}
            </Text>
          </Box>
        </Box>
      );
  }
}
