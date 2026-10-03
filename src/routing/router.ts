import type { ComplexityClassifier } from '../classifier/classifier.js';
import { profileFor, tierOfModel } from '../domain/model-catalog.js';
import { selectTier } from '../domain/policy.js';
import { maxTier, minTier, TIERS, type Tier, type TierScores } from '../domain/tiers.js';
import {
  conversationFingerprint,
  estimateInputTokens,
  isFreshConversation,
  latestHumanText,
  type MessagesBody,
} from './messages-body.js';
import type { TtlLruStore } from './session-store.js';

export type RouteReason =
  | 'passthrough:unknown-model'
  | 'passthrough:request-class'
  | 'passthrough:no-session-state'
  | 'passthrough:classifier-failed'
  | 'sticky'
  | 'classified'
  | 'escalated'
  | 'escalated:context'
  | 'fallback:upstream-rejected';

export interface RouteDecision {
  /** Model to send upstream. Equal to `body.model` means: do not touch the body. */
  readonly model: string;
  readonly requestedModel: string;
  readonly tier: Tier | undefined;
  readonly reason: RouteReason;
  readonly conversationKey: string | undefined;
  readonly scores?: TierScores;
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
  /** False for count_tokens: reuse the sticky decision, never spend a classification. */
  readonly mayClassify: boolean;
}

export interface RouterOptions {
  readonly threshold: number;
  readonly allowEscalation: boolean;
  readonly passthroughClasses: ReadonlySet<string>;
  readonly models: Readonly<Record<Tier, string>>;
  readonly classifierTimeoutMs: number;
  readonly classifierMaxChars: number;
}

/** Fraction of a model's context window we allow before excluding it. */
const CONTEXT_HEADROOM = 0.9;

/**
 * Session-sticky, escalate-only router.
 *
 * Why not per-request routing: prompt caches and thinking blocks are bound to
 * the model. Flipping models between agent-loop steps re-bills the entire
 * history uncached and discards reasoning — routinely costing more than the
 * cheaper model saves. So:
 *   - tool-result continuations reuse the conversation's tier (no classification);
 *   - a new human turn is classified, and may only escalate the tier;
 *   - a fresh or just-compacted conversation is classified from scratch;
 *   - the model the client asked for is a hard ceiling.
 */
export class Router {
  constructor(
    private readonly classifier: ComplexityClassifier,
    private readonly sessions: TtlLruStore<Tier>,
    private readonly options: RouterOptions,
  ) {}

  async decide(ctx: RequestContext): Promise<RouteDecision> {
    const requestedModel = ctx.body.model;
    const ceiling = tierOfModel(requestedModel);
    const base = { requestedModel, conversationKey: undefined } as const;

    if (!ceiling) return { ...base, model: requestedModel, tier: undefined, reason: 'passthrough:unknown-model' };
    if (ctx.requestClass && this.options.passthroughClasses.has(ctx.requestClass)) {
      return { ...base, model: requestedModel, tier: ceiling, reason: 'passthrough:request-class' };
    }

    const key = ctx.sessionId
      ? `${ctx.sessionId}:${ctx.agentId ?? 'main'}`
      : `fp:${conversationFingerprint(ctx.body)}`;
    const fresh = isFreshConversation(ctx.body) || ctx.contextCompacted;
    const stored = this.sessions.get(key);
    const inputTokens = estimateInputTokens(ctx.rawByteLength);
    const tooSmall = this.tiersTooSmallFor(inputTokens);

    const resolve = (tier: Tier, reason: RouteReason, extra: Partial<RouteDecision> = {}): RouteDecision => {
      // A growing conversation can outgrow its tier's window (Claude Code believes
      // it talks to the requested model and won't compact early): bump it.
      const fitted = tooSmall.has(tier) ? this.cheapestFitting(tooSmall, ceiling) : tier;
      const capped = minTier(maxTier(tier, fitted), ceiling);
      this.sessions.set(key, capped);
      return {
        ...base,
        ...extra,
        conversationKey: key,
        tier: capped,
        reason: fitted !== tier && capped !== tier ? 'escalated:context' : reason,
        // Same tier as requested → keep the client's exact model (e.g. Fable stays Fable).
        model: capped === ceiling ? requestedModel : this.options.models[capped],
      };
    };
    const passthrough = (reason: RouteReason, extra: Partial<RouteDecision> = {}): RouteDecision => ({
      ...base,
      ...extra,
      conversationKey: key,
      model: requestedModel,
      tier: ceiling,
      reason,
    });

    if (!ctx.mayClassify) return stored ? resolve(stored, 'sticky') : passthrough('passthrough:no-session-state');

    // An ongoing conversation we hold no state for (proxy restart, TTL expiry)
    // has been running on the client's model: treat that as its tier, so a
    // later classification can only escalate it, never yank it down mid-flight.
    const sticky = fresh ? undefined : (stored ?? ceiling);
    const humanText = latestHumanText(ctx.body);

    if (humanText === undefined) {
      return sticky ? resolve(sticky, 'sticky') : passthrough('passthrough:no-session-state');
    }
    if (sticky && !this.options.allowEscalation) return resolve(sticky, 'sticky');

    const started = performance.now();
    let scores: TierScores;
    try {
      scores = await this.classifier.classify(
        {
          text: humanText.slice(0, this.options.classifierMaxChars),
          turnCount: ctx.body.messages.length,
          toolCount: Array.isArray(ctx.body['tools']) ? ctx.body['tools'].length : 0,
          estimatedInputTokens: inputTokens,
        },
        AbortSignal.timeout(this.options.classifierTimeoutMs),
      );
    } catch (err) {
      const classifierError = err instanceof Error ? err.message : String(err);
      // Fail-open toward quality: keep the conversation's tier, else the client's model.
      return sticky
        ? resolve(sticky, 'sticky', { classifierError })
        : passthrough('passthrough:classifier-failed', { classifierError });
    }
    const classifierMs = Math.round(performance.now() - started);

    const proposed = selectTier({
      scores,
      threshold: this.options.threshold,
      ceiling,
      excluded: tooSmall,
    });

    if (!sticky) return resolve(proposed, 'classified', { scores, classifierMs });
    // Never de-escalate an ongoing conversation: same quality, but a cold cache.
    const next = maxTier(sticky, proposed);
    return resolve(next, next === sticky ? 'sticky' : 'escalated', { scores, classifierMs });
  }

  /**
   * The routed model rejected the request: run the rest of this conversation on
   * the model the client asked for instead of failing the same way every turn.
   */
  pinToRequested(decision: RouteDecision): void {
    const tier = tierOfModel(decision.requestedModel);
    if (decision.conversationKey && tier) this.sessions.set(decision.conversationKey, tier);
  }

  private cheapestFitting(tooSmall: ReadonlySet<Tier>, ceiling: Tier): Tier {
    return TIERS.find((t) => !tooSmall.has(t)) ?? ceiling;
  }

  private tiersTooSmallFor(tokens: number): ReadonlySet<Tier> {
    return new Set(
      TIERS.filter((t) => profileFor(this.options.models[t]).contextWindow * CONTEXT_HEADROOM < tokens),
    );
  }
}
