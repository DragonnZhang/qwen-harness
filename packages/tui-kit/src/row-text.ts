/**
 * The searchable/copyable text of a transcript row (UI-09).
 *
 * The inspector's search and a copy/export path both need "the visible content of this row" as a
 * plain string. That is derived ONLY from the row's `SafeText` fields — never from its trusted
 * chrome label — so search can never match into framing and copied text is always inert.
 */

import type { TranscriptRow } from './view-model.ts';

/** Concatenate a row's sanitized content into one searchable/copyable string. */
export function rowSearchText(row: TranscriptRow): string {
  switch (row.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning-summary':
      return row.text;
    case 'tool-call':
      return `${row.toolName} ${row.argsPreview}`;
    case 'tool-result':
      return `${row.toolName} ${row.preview}${row.errorCategory === null ? '' : ` ${row.errorCategory}`}`;
    case 'diff':
      return diffText(row);
    case 'error':
      return `${row.category} ${row.message}`;
    case 'usage':
      return 'usage';
    case 'progress':
      return row.detail ?? '';
    case 'approval':
      return `${row.decision} ${row.normalizedAction}`;
    case 'compaction':
      return row.summary;
    case 'user-shell':
      return `${row.command} ${row.output}`;
  }
}

function diffText(row: Extract<TranscriptRow, { kind: 'diff' }>): string {
  const parts: string[] = [];
  for (const file of row.diff.files) {
    if (file.oldPath !== null) parts.push(file.oldPath);
    if (file.newPath !== null) parts.push(file.newPath);
  }
  for (const hunk of row.diff.hunks) {
    parts.push(hunk.header);
    for (const dl of hunk.lines) parts.push(dl.text);
  }
  return parts.join('\n');
}
