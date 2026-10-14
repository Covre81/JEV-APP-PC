/**
 * The JSON object Claude Code pipes to a status line or hook; undefined for a
 * TTY, garbage, or nothing within `timeoutMs`. Kept apart from statusline.ts so
 * a hook does not load node:sqlite just to read its stdin.
 */
export async function readHookInput(stdin: NodeJS.ReadStream, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  if (stdin.isTTY) return undefined;
  const read = (async () => {
    let raw = '';
    for await (const chunk of stdin) raw += chunk;
    return raw;
  })();
  const timeout = new Promise<string>((resolve) => setTimeout(resolve, timeoutMs, '').unref());
  try {
    const input: unknown = JSON.parse(await Promise.race([read, timeout]));
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
