/**
 * A newline-delimited reader over a real input stream, used as the CLI's approval channel.
 *
 * It works whether stdin is a terminal or a pipe — an operator answering a prompt and a script
 * feeding `y` are the same channel, and both are a genuine human decision routed through the same
 * gate. What it never does is invent an answer: when the stream ends without one, it resolves
 * `null`, and `null` means "no channel", which the approval gate turns into `deferred`, never into
 * consent.
 */
export function stdinLineReader(
  stream: NodeJS.ReadableStream,
  write: (text: string) => void,
): (prompt: string) => Promise<string | null> {
  let buffer = '';
  let ended = false;
  let attached = false;
  const waiting: ((line: string | null) => void)[] = [];

  const drain = (): void => {
    while (waiting.length > 0) {
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        waiting.shift()?.(line);
        continue;
      }
      if (ended) {
        // A final line without a trailing newline still counts; after that, the channel is closed.
        const rest = buffer;
        buffer = '';
        waiting.shift()?.(rest.length > 0 ? rest : null);
        continue;
      }
      return;
    }
  };

  const attach = (): void => {
    if (attached) return;
    attached = true;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      drain();
    });
    stream.on('end', () => {
      ended = true;
      drain();
    });
    stream.on('error', () => {
      ended = true;
      drain();
    });
  };

  return (prompt: string) =>
    new Promise<string | null>((resolve) => {
      attach();
      write(prompt);
      waiting.push(resolve);
      drain();
    });
}
