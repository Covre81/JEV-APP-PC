import { existsSync } from 'node:fs';
import { openTelemetryDb } from './telemetry/db.js';
import { cheapShare, lastRoute, renderStatusLine, sessionContext, type StatusLineData } from './telemetry/statusline.js';

const HEALTH_TIMEOUT_MS = 500;
const STDIN_TIMEOUT_MS = 300;

export interface StatusLineOptions {
  readonly dbPath: string;
  readonly healthUrl: string;
  readonly sessionId?: string;
}

/**
 * Builds the Claude Code status line. Claude Code runs it after each message;
 * it must answer fast and never fail, so every error degrades to less
 * information instead of an exception.
 */
export async function statusLine({ dbPath, healthUrl, sessionId }: StatusLineOptions): Promise<string> {
  const healthy = await probeHealth(healthUrl);
  let data: StatusLineData = { healthy };
  if (healthy && existsSync(dbPath)) {
    try {
      const db = openTelemetryDb(dbPath, { readonly: true });
      try {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const last = lastRoute(db, sessionId);
        const context = sessionContext(db, sessionId);
        data = { healthy, ...(last ? { last } : {}), ...(context === undefined ? {} : { context }), today: cheapShare(db, midnight) };
      } finally {
        db.close();
      }
    } catch {
      // A locked or half-migrated database only costs the details.
    }
  }
  return renderStatusLine(data);
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Claude Code pipes the session as JSON on stdin; anything else (a TTY, garbage, silence) means no session. */
export async function readSessionId(stdin: NodeJS.ReadStream = process.stdin): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const read = (async () => {
    let raw = '';
    for await (const chunk of stdin) raw += chunk;
    return raw;
  })();
  const timeout = new Promise<string>((resolve) => setTimeout(resolve, STDIN_TIMEOUT_MS, '').unref());
  try {
    const id = (JSON.parse(await Promise.race([read, timeout])) as { session_id?: unknown }).session_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}
