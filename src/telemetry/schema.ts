import type { QuotaSnapshot } from '../quota.js';
import type { TelemetryDb } from './db.js';

/** JEV's System One verdict for the turn that set the route (null when JEV was not consulted). */
export interface JevDecision {
  /** Full distribution over the three ordinal levels. */
  readonly simple: number;
  readonly standard: number;
  readonly structural: number;
  /** P(simple) — level 1, the only mass the cheap route is gated on by default. */
  readonly pSimple: number;
  /** P(complex) — level 3 ("structural"), the work the primary quota is reserved for. */
  readonly pComplex: number;
  readonly classifierMs: number | null;
  /** Tokens the JEV call billed; absent on rows written before they were recorded. */
  readonly tokensIn?: number | null;
  readonly tokensOut?: number | null;
  /** Highest risk Noul; >= 0.5 forced the primary route. Absent on older rows. */
  readonly risk?: number | null;
  /** Versioned JEV model that scored the turn; absent on older rows. */
  readonly model?: string | null;
}

export type FinalProvider = 'anthropic' | 'openai';

/**
 * Outcome of the exchange as seen by the client:
 *   ok            — upstream answered 2xx and the body was delivered in full
 *   http_error    — upstream answered with a non-2xx status
 *   stream_error  — a 2xx stream broke (or carried an `error` event) mid-flight
 *   client_abort  — the client hung up before the body finished
 *   proxy_error   — no upstream response at all (502 from jev-router)
 */
export type Outcome = 'ok' | 'http_error' | 'stream_error' | 'client_abort' | 'proxy_error';

/** One `router_logs` row per `/v1/messages` exchange routed by jev-router. */
export interface RouterLog {
  readonly createdAt: Date;
  /** Conversation key: `<x-claude-code-session-id>:<agent>` or a body fingerprint. */
  readonly sessionId: string | null;
  /** sha256 of the latest human-typed text; null on tool-result continuations. */
  readonly humanPromptHash: string | null;
  readonly jevDecision: JevDecision | null;
  readonly finalProvider: FinalProvider;
  /** Model that served the request (the cheap model on the cheap route). */
  readonly model: string | null;
  /** Model the client asked for: what Anthropic would have run had the request stayed there. */
  readonly requestedModel: string | null;
  readonly routeReason: string;
  readonly requestClass: string | null;
  readonly httpStatus: number | null;
  readonly outcome: Outcome;
  /** Total prompt tokens, cache reads and writes included (null when the response carried no usage). */
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** Portion of tokens_in served from the Anthropic prompt cache. */
  readonly cacheReadTokens: number | null;
  /** Portion of tokens_in written to the Anthropic prompt cache. */
  readonly cacheWriteTokens: number | null;
  /** Request received → last byte sent to the client. */
  readonly latencyMs: number;
  /** The cheap provider failed before answering and the request fell back to Anthropic. */
  readonly fallbackTriggered: boolean;
  /** Tools the client offered (`body.tools`); null on rows written before it was recorded. */
  readonly toolsOffered: number | null;
  /** `tool_use` blocks in the response. */
  readonly toolCalls: number | null;
  /**
   * Cheap-route answer, delivered ok, that called none of the tools it was
   * offered: the misroute signal ("is everything ok here?" answered without
   * looking). Null on Anthropic rows, where it says nothing.
   */
  readonly inspectionMiss: boolean | null;
  /** Binding Claude quota window (0..1) when the exchange was routed; null when none was seen yet. */
  readonly quotaUtilization: number | null;
}

export type NewRouterLog = Pick<RouterLog, 'createdAt' | 'finalProvider' | 'routeReason' | 'outcome' | 'latencyMs'> &
  Partial<RouterLog>;

/** Applied in order on boot; `PRAGMA user_version` records how many have run. Append only. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE router_logs (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    created_at integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
    session_id text,
    human_prompt_hash text,
    jev_decision text,
    final_provider text NOT NULL,
    model text,
    route_reason text NOT NULL,
    request_class text,
    http_status integer,
    outcome text NOT NULL,
    tokens_in integer,
    tokens_out integer,
    cache_read_tokens integer,
    latency_ms integer NOT NULL,
    fallback_triggered integer DEFAULT false NOT NULL
  );
  CREATE INDEX router_logs_created_at_idx ON router_logs (created_at);
  CREATE INDEX router_logs_session_id_idx ON router_logs (session_id);
  CREATE INDEX router_logs_prompt_hash_idx ON router_logs (human_prompt_hash);`,
  `ALTER TABLE router_logs ADD requested_model text;
  ALTER TABLE router_logs ADD cache_write_tokens integer;`,
  `ALTER TABLE router_logs ADD tools_offered integer;
  ALTER TABLE router_logs ADD tool_calls integer;
  ALTER TABLE router_logs ADD inspection_miss integer;`,
  `CREATE TABLE quota_observations (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    created_at integer NOT NULL,
    utilization real NOT NULL,
    window text NOT NULL,
    status text,
    reset_at integer
  );
  ALTER TABLE router_logs ADD quota_utilization real;`,
];

/**
 * One row per meaningful quota change (QuotaStore.onChange): the status line
 * runs in another process and reads the latest one.
 */
export function recordQuota(db: TelemetryDb, s: QuotaSnapshot): void {
  db.prepare(
    `INSERT INTO quota_observations (created_at, utilization, window, status, reset_at)
     VALUES (@createdAt, @utilization, @window, @status, @resetAt)`,
  ).run({
    createdAt: s.observedAt.getTime(),
    utilization: s.utilization,
    window: s.window,
    status: s.status ?? null,
    resetAt: s.resetAt?.getTime() ?? null,
  });
}

export const INSERT_ROUTER_LOG = `INSERT INTO router_logs (
  created_at, session_id, human_prompt_hash, jev_decision, final_provider, model, requested_model, route_reason,
  request_class, http_status, outcome, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, latency_ms,
  fallback_triggered, tools_offered, tool_calls, inspection_miss, quota_utilization
) VALUES (
  @createdAt, @sessionId, @humanPromptHash, @jevDecision, @finalProvider, @model, @requestedModel, @routeReason,
  @requestClass, @httpStatus, @outcome, @tokensIn, @tokensOut, @cacheReadTokens, @cacheWriteTokens, @latencyMs,
  @fallbackTriggered, @toolsOffered, @toolCalls, @inspectionMiss, @quotaUtilization
)`;

/** Named parameters for INSERT_ROUTER_LOG: dates as epoch ms, JSON as text, booleans as 0/1. */
export const insertParams = (r: NewRouterLog) => ({
  createdAt: r.createdAt.getTime(),
  sessionId: r.sessionId ?? null,
  humanPromptHash: r.humanPromptHash ?? null,
  jevDecision: r.jevDecision ? JSON.stringify(r.jevDecision) : null,
  finalProvider: r.finalProvider,
  model: r.model ?? null,
  requestedModel: r.requestedModel ?? null,
  routeReason: r.routeReason,
  requestClass: r.requestClass ?? null,
  httpStatus: r.httpStatus ?? null,
  outcome: r.outcome,
  tokensIn: r.tokensIn ?? null,
  tokensOut: r.tokensOut ?? null,
  cacheReadTokens: r.cacheReadTokens ?? null,
  cacheWriteTokens: r.cacheWriteTokens ?? null,
  latencyMs: r.latencyMs,
  fallbackTriggered: r.fallbackTriggered ? 1 : 0,
  toolsOffered: r.toolsOffered ?? null,
  toolCalls: r.toolCalls ?? null,
  inspectionMiss: r.inspectionMiss == null ? null : r.inspectionMiss ? 1 : 0,
  quotaUtilization: r.quotaUtilization ?? null,
});
