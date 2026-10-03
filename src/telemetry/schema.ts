import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/** One row per `/v1/messages` exchange routed by jev-router. */
export const routerLogs = sqliteTable(
  'router_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    /** Conversation key: `<x-claude-code-session-id>:<agent>` or a body fingerprint. */
    sessionId: text('session_id'),
    /** sha256 of the latest human-typed text; null on tool-result continuations. */
    humanPromptHash: text('human_prompt_hash'),
    jevDecision: text('jev_decision', { mode: 'json' }).$type<JevDecision>(),
    finalProvider: text('final_provider', { enum: ['anthropic', 'openai'] }).notNull(),
    model: text('model'),
    routeReason: text('route_reason').notNull(),
    requestClass: text('request_class'),
    httpStatus: integer('http_status'),
    outcome: text('outcome', { enum: ['ok', 'http_error', 'stream_error', 'client_abort', 'proxy_error'] }).notNull(),
    /** Total prompt tokens, cache reads and writes included (null when the response carried no usage). */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** Portion of tokens_in served from the Anthropic prompt cache. */
    cacheReadTokens: integer('cache_read_tokens'),
    /** Request received → last byte sent to the client. */
    latencyMs: integer('latency_ms').notNull(),
    /** The cheap provider failed before answering and the request fell back to Anthropic. */
    fallbackTriggered: integer('fallback_triggered', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('router_logs_created_at_idx').on(t.createdAt),
    index('router_logs_session_id_idx').on(t.sessionId),
    index('router_logs_prompt_hash_idx').on(t.humanPromptHash),
  ],
);

export type RouterLog = typeof routerLogs.$inferSelect;
export type NewRouterLog = typeof routerLogs.$inferInsert;
