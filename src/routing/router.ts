import type { Classification, ComplexityClassifier } from '../classifier/classifier.js';
import type { ComplexityDistribution } from '../domain/complexity.js';
import { selectTier, stickyTier, tierRoute, type PolicyOptions, type Route, type Tier } from '../domain/policy.js';
import {
  conversationFingerprint,
  estimateInputTokens,
  isFreshConversation,
  latestHumanText,
  type MessagesBody,
} from './messages-body.js';
import type { QuotaLevel } from '../quota.js';
import type { TtlLruStore } from './session-store.js';

export type RouteReason =
  | 'passthrough:request-class'
  | 'passthrough:no-session-state'
  | 'passthrough:classifier-failed'
  | 'sticky'
  | 'classified'
  | 'escalated'
  | 'escalated:standard'
  | 'escalated:context'
  | 'failover:cheap-unavailable'
  | 'skipped:cheap-unhealthy'
  | 'pinned:compaction'
  | 'quota:pressure'
  | 'quota:reclassified'
  | 'failover:primary-rate-limited';

export interface RouteDecision {
  readonly route: Route;
  /** Which cheap model serves a cheap route; absent on decisions built outside the router. */
  readonly tier?: Tier;
  readonly reason: RouteReason;
  readonly conversationKey: string | undefined;
  readonly distribution?: Classification;
  readonly classifierMs?: number;
  readonly classifierError?: string;
}

/** Facts about the request that live outside the body (Claude Code headers). */
export interface RequestContext {
  readonly body: MessagesBody;
  readonly rawByteLength: number;
  readonly sessionId: string | undefined;
  readonly agentId: string | undefined;
  readonly requestClass: string | undefined;
  readonly contextCompacted: boolean;
}

export interface RouterOptions {
  readonly policy: PolicyOptions;
  /** x-claude-code-request-class values that always use the primary provider. */
  readonly primaryClasses: ReadonlySet<string>;
  /** Input-token budget of the trivial-tier model (its context window minus headroom). */
  readonly cheapContextTokens: number;
  /** Input-token budget of the standard-tier model; defaults to the trivial one. */
  readonly standardContextTokens?: number;
  readonly classifierTimeoutMs: number;
  readonly classifierMaxChars: number;
  /** Claude quota as last seen on an Anthropic response; absent = quota routing off. */
  readonly quota?: { level(): QuotaLevel };
  /** Bars used from `pressure` on; each only lowers the normal one. */
  readonly pressurePolicy?: { readonly minCheapProbability: number; readonly minStandardProbability: number };
}

const TIER_RANK: Readonly<Record<Tier, number>> = { trivial: 0, standard: 1, primary: 2 };

/**
 * Multi-provider router: decides, per conversation, between a cheap
 * OpenAI-compatible provider and the primary Anthropic quota. It only decides —
 * base URLs, headers and wire formats belong to `src/providers`.
 *
 * Rules:
 *   - a fresh (or just-compacted) conversation is classified by JEV;
 *   - tool-result continuations reuse the conversation's route (no JEV call);
 *   - a new human turn on the cheap route is re-classified and may escalate;
 *   - primary is terminal, except under critical quota, where a new human
 *     turn may leave it (and a compaction no longer pins it there);
 *   - anything the cheap model cannot hold (context) goes primary;
 *   - JEV failure fails toward primary — losing savings, never correctness.
 */
export class Router {
  constructor(
    private readonly classifier: ComplexityClassifier,
    private readonly sessions: TtlLruStore<Tier>,
    private readonly options: RouterOptions,
  ) {}

  async decide(ctx: RequestContext): Promise<RouteDecision> {
    if (ctx.requestClass && this.options.primaryClasses.has(ctx.requestClass)) {
      return { route: 'primary', reason: 'passthrough:request-class', conversationKey: undefined };
    }

    const key = ctx.sessionId
      ? `${ctx.sessionId}:${ctx.agentId ?? 'main'}`
      : `fp:${conversationFingerprint(ctx.body)}`;
    const fresh = isFreshConversation(ctx.body) || ctx.contextCompacted;
    const inputTokens = estimateInputTokens(ctx.rawByteLength);
    const budget: Readonly<Record<Tier, number>> = {
      trivial: this.options.cheapContextTokens,
      standard: this.options.standardContextTokens ?? this.options.cheapContextTokens,
      primary: Infinity,
    };

    const resolve = (tier: Tier, reason: RouteReason, extra: Partial<RouteDecision> = {}): RouteDecision => {
      const escalatedByContext = inputTokens > budget[tier];
      const final: Tier = escalatedByContext ? 'primary' : tier;
      this.sessions.set(key, final);
      return {
        ...extra,
        route: tierRoute(final),
        tier: final,
        reason: escalatedByContext ? 'escalated:context' : reason,
        conversationKey: key,
      };
    };
    const primary = (reason: RouteReason, extra: Partial<RouteDecision> = {}): RouteDecision => ({
      ...extra,
      route: 'primary',
      tier: 'primary',
      reason,
      conversationKey: key,
    });

    const level = this.options.quota?.level() ?? 'none';
    const pressure = this.options.pressurePolicy;
    const policy: PolicyOptions =
      level === 'none' || !pressure
        ? this.options.policy
        : {
            ...this.options.policy,
            minCheapProbability: Math.min(this.options.policy.minCheapProbability, pressure.minCheapProbability),
            minStandardProbability: Math.min(this.options.policy.minStandardProbability ?? 1, pressure.minStandardProbability),
          };

    // A conversation we hold no state for (proxy restart, TTL expiry) has been
    // running on the primary: keep it there rather than switching mid-flight.
    const stored: Tier = this.sessions.get(key) ?? 'primary';
    // Compaction used to count as a fresh start, dropping long Claude sessions on the 20B.
    if (ctx.contextCompacted && stored === 'primary' && level !== 'critical') return resolve('primary', 'pinned:compaction');
    const sticky: Tier | undefined = fresh ? undefined : stored;

    const humanText = latestHumanText(ctx.body);
    // Quota nearly gone: a new human turn on Claude may leave it. Tool loops never do.
    const reclassify = level === 'critical' && humanText !== undefined && stored === 'primary' && (sticky === 'primary' || ctx.contextCompacted);

    if (sticky === 'primary' && !reclassify) return resolve('primary', 'sticky');
    if (humanText === undefined) {
      return sticky ? resolve(sticky, 'sticky') : primary('passthrough:no-session-state');
    }

    const started = performance.now();
    let distribution: Classification;
    try {
      distribution = await this.classifier.classify(
        {
          text: humanText.slice(0, this.options.classifierMaxChars),
          turnCount: ctx.body.messages.length,
          toolCount: Array.isArray(ctx.body['tools']) ? ctx.body['tools'].length : 0,
          estimatedInputTokens: inputTokens,
        },
        AbortSignal.timeout(this.options.classifierTimeoutMs),
      );
    } catch (err) {
      // An unscored human turn may be structural: fail toward primary even mid-conversation.
      const classifierError = err instanceof Error ? err.message : String(err);
      return resolve('primary', 'passthrough:classifier-failed', { classifierError });
    }
    const classifierMs = Math.round(performance.now() - started);

    // The risk veto runs inside selectTier, before any bar: no quota level moves a risky turn.
    const proposed = selectTier(distribution, policy);
    const extra = { distribution, classifierMs };
    if (reclassify) return resolve(proposed, proposed === 'primary' ? 'sticky' : 'quota:reclassified', extra);
    if (!sticky) {
      const lowered = policy !== this.options.policy && TIER_RANK[proposed] < TIER_RANK[selectTier(distribution, this.options.policy)];
      return resolve(proposed, lowered ? 'quota:pressure' : 'classified', extra);
    }

    const next = stickyTier(sticky, proposed);
    const reason: RouteReason = next === sticky ? 'sticky' : next === 'standard' ? 'escalated:standard' : 'escalated';
    return resolve(next, reason, extra);
  }

  /** The cheap provider could not serve this conversation: keep it on the primary from now on. */
  pinToPrimary(decision: RouteDecision): void {
    if (decision.conversationKey) this.sessions.set(decision.conversationKey, 'primary');
  }
}
