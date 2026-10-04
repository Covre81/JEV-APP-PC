import { computeNetCost, type CostRow, type NetCost } from './cost.js';
import type { TelemetryDb } from './db.js';
import { pricingFromEnv, type Pricing } from './pricing.js';
import type { FinalProvider } from './schema.js';

export interface ProviderStats {
  readonly requests: number;
  readonly ok: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly avgLatencyMs: number | null;
}

export interface RouterStats {
  readonly since: Date | null;
  readonly firstAt: Date | null;
  readonly lastAt: Date | null;
  readonly total: number;
  readonly byProvider: Readonly<Record<FinalProvider, ProviderStats>>;
  /** Requests JEV actually scored (the rest were sticky, auxiliary or classifier failures). */
  readonly classified: number;
  /** Cheap provider failed before answering; the request went to Anthropic. */
  readonly fallbacks: number;
  /** Cheap provider broke mid-stream; Claude Code retries, the conversation is pinned to Anthropic. */
  readonly cheapStreamErrors: number;
  /** Human prompts sent more than once (same sha256), and the extra sends. */
  readonly repeatedPrompts: number;
  readonly repeatedSends: number;
  /**
   * Estimate of Anthropic tokens the System One layer kept off the primary
   * quota: in + out tokens of requests the cheap provider served successfully.
   */
  readonly estimatedTokensSaved: number;
  /** Dollar view: actual spend versus the all-Anthropic baseline, cache-miss penalty included. */
  readonly cost: NetCost;
  readonly cheapPriceUnset: boolean;
  readonly jevPriceUnset: boolean;
}

export interface StatsOptions {
  readonly since?: Date;
  readonly pricing?: Pricing;
}

const EMPTY: ProviderStats = { requests: 0, ok: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, avgLatencyMs: null };

export function computeStats(db: TelemetryDb, options: StatsOptions = {}): RouterStats {
  const { since } = options;
  const pricing = options.pricing ?? pricingFromEnv({});
  const params = { since: since?.getTime() ?? null };
  const inWindow = 'WHERE (@since IS NULL OR created_at >= @since)';
  const all = <T>(sql: string) => db.prepare(sql).all(params) as T[];
  const get = <T>(sql: string) => db.prepare(sql).get(params) as T;

  const rows = all<{ provider: FinalProvider } & ProviderStats>(`
    SELECT final_provider AS provider, count(*) AS requests,
      sum(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
      coalesce(sum(tokens_in), 0) AS tokensIn, coalesce(sum(tokens_out), 0) AS tokensOut,
      coalesce(sum(cache_read_tokens), 0) AS cacheReadTokens, avg(latency_ms) AS avgLatencyMs
    FROM router_logs ${inWindow} GROUP BY final_provider`);

  const byProvider: Record<FinalProvider, ProviderStats> = { anthropic: EMPTY, openai: EMPTY };
  for (const r of rows) {
    byProvider[r.provider] = {
      requests: r.requests,
      ok: r.ok,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cacheReadTokens: r.cacheReadTokens,
      avgLatencyMs: r.avgLatencyMs === null ? null : Math.round(r.avgLatencyMs),
    };
  }

  const summary = get<{
    total: number;
    firstAt: number | null;
    lastAt: number | null;
    classified: number;
    fallbacks: number;
    saved: number;
  }>(`
    SELECT count(*) AS total, min(created_at) AS firstAt, max(created_at) AS lastAt,
      coalesce(sum(CASE WHEN jev_decision IS NOT NULL THEN 1 ELSE 0 END), 0) AS classified,
      coalesce(sum(fallback_triggered), 0) AS fallbacks,
      coalesce(sum(CASE WHEN final_provider = 'openai' AND outcome = 'ok'
        THEN coalesce(tokens_in, 0) + coalesce(tokens_out, 0) ELSE 0 END), 0) AS saved
    FROM router_logs ${inWindow}`);

  const cheapStreamErrors = get<{ n: number }>(
    `SELECT count(*) AS n FROM router_logs ${inWindow} AND final_provider = 'openai' AND outcome = 'stream_error'`,
  ).n;

  const repeats = all<{ sends: number }>(`
    SELECT count(*) AS sends FROM router_logs ${inWindow} AND human_prompt_hash IS NOT NULL
    GROUP BY human_prompt_hash HAVING count(*) > 1`);

  // With --since, a session whose earlier turns fall outside the window starts
  // fresh: a cheap → Anthropic transition across the boundary is not penalized.
  const costRows = all<CostRow>(`
    SELECT id, session_id AS sessionId, final_provider AS finalProvider, model, requested_model AS requestedModel,
      outcome, tokens_in AS tokensIn, tokens_out AS tokensOut, cache_read_tokens AS cacheReadTokens,
      cache_write_tokens AS cacheWriteTokens,
      json_extract(jev_decision, '$.tokensIn') AS jevTokensIn, json_extract(jev_decision, '$.tokensOut') AS jevTokensOut
    FROM router_logs ${inWindow} ORDER BY id`);

  return {
    since: since ?? null,
    firstAt: summary.firstAt === null ? null : new Date(summary.firstAt),
    lastAt: summary.lastAt === null ? null : new Date(summary.lastAt),
    total: summary.total,
    byProvider,
    classified: summary.classified,
    fallbacks: summary.fallbacks,
    cheapStreamErrors,
    repeatedPrompts: repeats.length,
    repeatedSends: repeats.reduce((n, r) => n + r.sends - 1, 0),
    estimatedTokensSaved: summary.saved,
    cost: computeNetCost(costRows, pricing),
    cheapPriceUnset: pricing.cheapPriceUnset,
    jevPriceUnset: pricing.jevPriceUnset,
  };
}

/** `24h`, `7d`, `30m` → the instant that far back from `now`. */
export function parseSince(span: string, now = Date.now()): Date {
  const m = /^(\d+)\s*([mhd])$/.exec(span.trim());
  if (!m) throw new Error(`invalid --since "${span}": use <n>m, <n>h or <n>d`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  return new Date(now - Number(m[1]) * unit);
}

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (part: number, whole: number) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`);

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  const line = (r: readonly string[]) =>
    r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ');
  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(rows[0]!), rule, ...rows.slice(1).map(line)].join('\n');
}

export function renderStats(s: RouterStats): string {
  const a = s.byProvider.anthropic;
  const o = s.byProvider.openai;
  const window = s.since ? `since ${s.since.toISOString()}` : 'all time';
  const span = s.firstAt && s.lastAt ? `${s.firstAt.toISOString()} → ${s.lastAt.toISOString()}` : 'no data';

  const overview = table([
    ['jev-router stats', window],
    ['Requests', fmt(s.total)],
    ['Diverted from Anthropic (cheap route)', `${fmt(o.requests)} (${pct(o.requests, s.total)})`],
    ['  served OK by cheap provider', fmt(o.ok)],
    ['  cheap stream errors (retried on Anthropic)', fmt(s.cheapStreamErrors)],
    ['Fallbacks cheap → Anthropic', fmt(s.fallbacks)],
    ['Scored by JEV', fmt(s.classified)],
    ['Repeated prompts (extra sends)', `${fmt(s.repeatedPrompts)} (${fmt(s.repeatedSends)})`],
    ['Estimated Anthropic tokens saved', fmt(s.estimatedTokensSaved)],
  ]);

  const providers = table([
    ['Provider', 'Requests', 'OK', 'Tokens in', 'Tokens out', 'Cache read', 'Avg latency'],
    ...(
      [
        ['anthropic', a],
        ['openai (cheap)', o],
      ] as const
    ).map(([name, p]) => [
      name,
      fmt(p.requests),
      fmt(p.ok),
      fmt(p.tokensIn),
      fmt(p.tokensOut),
      fmt(p.cacheReadTokens),
      p.avgLatencyMs === null ? '—' : `${fmt(p.avgLatencyMs)} ms`,
    ]),
  ]);

  const c = s.cost;
  const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(4)}`;
  const verdict = c.netUsd >= 0 ? 'PROFIT' : 'LOSS';
  const costs = table([
    ['Net cost (USD, API list prices)', ''],
    ['All-Anthropic baseline (warm cache)', money(c.baselineUsd)],
    ['Actual: Anthropic', money(c.anthropicUsd)],
    ['Actual: cheap provider', money(c.cheapUsd)],
    ['Gross savings (cheap requests served OK)', money(c.grossSavingsUsd)],
    [`Cache-miss penalty (${fmt(c.transitions)} cheap → Anthropic returns)`, money(-c.cachePenaltyUsd)],
    ['Failed cheap attempts (paid, then redone)', money(-c.failedCheapUsd)],
    ['Classifier (JEV) calls', money(-c.jevUsd)],
    [`NET (${verdict})`, money(c.netUsd)],
  ]);
  const warnings = [
    ...(s.cheapPriceUnset
      ? ['! Cheap provider priced at $0: set CHEAP_PRICE_INPUT_PER_MTOK / CHEAP_PRICE_OUTPUT_PER_MTOK (leave unset only for local models).']
      : []),
    ...(s.jevPriceUnset && s.classified > 0
      ? ['! JEV priced at $0: set JEV_PRICE_INPUT_PER_MTOK / JEV_PRICE_OUTPUT_PER_MTOK from your TypeSafe plan.']
      : []),
    ...(c.unpricedModels.length > 0 ? [`! No list price for ${c.unpricedModels.join(', ')}: priced at $0, set PRIMARY_PRICE_*.`] : []),
    ...(c.rowsWithoutUsage > 0 ? [`! ${fmt(c.rowsWithoutUsage)} requests carried no token usage and count as $0.`] : []),
  ];

  return [
    overview,
    '',
    providers,
    '',
    costs,
    ...(warnings.length > 0 ? ['', ...warnings] : []),
    '',
    `Window: ${span}`,
    'Tokens saved = tokens in + out of requests the cheap provider served OK. Estimate:',
    "the cheap model's tokenizer differs from Claude's, and on Anthropic part of that",
    'input would have been a cache read. Rows without usage count as 0.',
    'Dollars are API-equivalent: on a claude.ai subscription they measure quota, not a bill.',
  ].join('\n');
}
