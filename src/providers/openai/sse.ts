/**
 * Minimal Server-Sent Events reader: yields the `data` payload of each event.
 * Handles chunk boundaries anywhere, CRLF, multi-line data and comments.
 */
export async function* readSseData(source: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  const flushEvent = function* (event: string): Generator<string> {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length > 0) yield data.join('\n');
  };

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n?/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      yield* flushEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* flushEvent(buffer.replace(/\r\n?/g, '\n'));
}

/** Serializes one Anthropic-style SSE event. */
export function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
