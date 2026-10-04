import type { TelemetryDb } from './db.js';

/** What the Claude Code status line needs: is the router up, and where did this session's last turn go. */
export interface StatusLineData {
  readonly healthy: boolean;
  readonly last?: LastRoute;
  readonly today?: { readonly cheap: number; readonly total: number };
}

export interface LastRoute {
  readonly provider: 'anthropic' | 'openai';
  readonly reason: string;
  readonly outcome: string;
  /** P(simple) from JEV; undefined when JEV was not asked (sticky turn, auxiliary request). */
  readonly pSimple?: number;
}

interface LastRow {
  provider: 'anthropic' | 'openai';
  reason: string;
  outcome: string;
  jev: string | null;
}

/**
 * Last exchange of a Claude Code session. Telemetry keys conversations as
 * `<session id>:<agent>`, so every agent of the session counts. Without a
 * session id (or before its first turn) there is nothing to show.
 */
export function lastRoute(db: TelemetryDb, sessionId: string | undefined): LastRoute | undefined {
  if (!sessionId) return undefined;
  const row = db
    .prepare(
      `SELECT final_provider AS provider, route_reason AS reason, outcome, jev_decision AS jev
       FROM router_logs WHERE substr(session_id, 1, length(@prefix)) = @prefix ORDER BY id DESC LIMIT 1`,
    )
    .get({ prefix: `${sessionId}:` }) as LastRow | undefined;
  if (!row) return undefined;
  const pSimple = row.jev ? (JSON.parse(row.jev) as { pSimple?: number }).pSimple : undefined;
  return { provider: row.provider, reason: row.reason, outcome: row.outcome, ...(pSimple === undefined ? {} : { pSimple }) };
}

/** Requests since `since` and how many of them the cheap provider answered. */
export function cheapShare(db: TelemetryDb, since: Date): { cheap: number; total: number } {
  return db
    .prepare(
      `SELECT count(*) AS total, coalesce(sum(CASE WHEN final_provider = 'openai' AND outcome = 'ok' THEN 1 ELSE 0 END), 0) AS cheap
       FROM router_logs WHERE created_at >= @since`,
    )
    .get({ since: since.getTime() }) as { cheap: number; total: number };
}

/** One line, plain text: Claude Code prints the first line of stdout under the prompt. */
export function renderStatusLine({ healthy, last, today }: StatusLineData): string {
  if (!healthy) return 'jev-router ✗ offline';
  const parts = ['jev-router ✓'];
  if (last) {
    const where = last.provider === 'openai' ? 'cheap' : 'claude';
    const why = last.pSimple !== undefined ? `JEV ${last.pSimple.toFixed(2)}` : last.reason;
    parts.push(`last: ${where} (${why})${last.outcome === 'ok' ? '' : ` ${last.outcome}`}`);
  }
  if (today && today.total > 0) parts.push(`today ${today.cheap}/${today.total} cheap`);
  return parts.join(' · ');
}
