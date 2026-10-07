import type { Classification, ComplexityClassifier } from '../classifier/classifier.js';
import type { ComplexityDistribution } from '../domain/complexity.js';
import { selectRoute, stickyRoute, type PolicyOptions, type Route } from '../domain/policy.js';
import {
  conversationFingerprint,
  estimateInputTokens,
  isFreshConversation,
  latestHumanText,
  type MessagesBody,
} from './messages-body.js';
import type { TtlLruStore } from './session-store.js';

export type RouteReason =
  | 'passthrough:request-class'
  | 'passthrough:no-session-state'
  | 'passthrough:classifier-failed'
  | 'sticky'
  | 'classified'
  | 'escalated'
  | 'escalated:context'
  | 'failover:cheap-unavailable'
  | 'skipped:cheap-unhealthy'
  | 'failover:primary-rate-limited';

export interface RouteDecision {
  readonly route: Route;
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
  /** Input-token budget of the cheap model (its context window minus headroom). */
  readonly cheapContextTokens: number;
  readonly classifierTimeoutMs: number;
  readonly classifierMaxChars: number;
}

/**
 * Multi-provider router: decides, per conversation, between a cheap
 * OpenAI-compatible provider and the primary Anthropic quota. It only decides —
 * base URLs, headers and wire formats belong to `src/providers`.
 *
 * Rules:
 *   - a fresh (or just-compacted) conversation is classified by JEV;
 *   - tool-result continuations reuse the conversation's route (no JEV call);
 *   - a new human turn on the cheap route is re-classified and may escalate;
 *   - primary is terminal: conversations never fall back to cheap;
 *   - anything the cheap model cannot hold (context) goes primary;
 *   - JEV failure fails toward primary — losing savings, never correctness.
 */
export class Router {
  constructor(
    private readonly classifier: ComplexityClassifier,
    private readonly sessions: TtlLruStore<Route>,
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
    const fitsCheap = inputTokens <= this.options.cheapContextTokens;

    const resolve = (route: Route, reason: RouteReason, extra: Partial<RouteDecision> = {}): RouteDecision => {
      const escalatedByContext = route === 'cheap' && !fitsCheap;
      const final: Route = escalatedByContext ? 'primary' : route;
      this.sessions.set(key, final);
      return { ...extra, route: final, reason: escalatedByContext ? 'escalated:context' : reason, conversationKey: key };
    };
    const primary = (reason: RouteReason, extra: Partial<RouteDecision> = {}): RouteDecision => ({
      ...extra,
      route: 'primary',
      reason,
      conversationKey: key,
    });

    // A conversation we hold no state for (proxy restart, TTL expiry) has been
    // running on the primary: keep it there rather than switching mid-flight.
    const sticky: Route | undefined = fresh ? undefined : (this.sessions.get(key) ?? 'primary');

    if (sticky === 'primary') return resolve('primary', 'sticky');

    const humanText = latestHumanText(ctx.body);
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

    const proposed = selectRoute(distribution, this.options.policy);
    if (!sticky) return resolve(proposed, 'classified', { distribution, classifierMs });

    const next = stickyRoute(sticky, proposed);
    return resolve(next, next === sticky ? 'sticky' : 'escalated', { distribution, classifierMs });
  }

  /** The cheap provider could not serve this conversation: keep it on the primary from now on. */
  pinToPrimary(decision: RouteDecision): void {
    if (decision.conversationKey) this.sessions.set(decision.conversationKey, 'primary');
  }
}
