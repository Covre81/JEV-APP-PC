import type { ComplexityDistribution } from './complexity.js';

/**
 * Where a conversation runs.
 *   cheap   — an OpenAI-compatible provider (Groq, OpenRouter, …), billed per token
 *   primary — Anthropic, the quota reserved for heavy lifting
 */
export type Route = 'cheap' | 'primary';

export interface PolicyOptions {
  /** Minimum probability that the task is cheap-eligible before leaving the primary quota. */
  readonly minCheapProbability: number;
  /** Where level-2 ("standard") work goes. `primary` unless you have measured otherwise. */
  readonly standardRoute: Route;
}

/**
 * Deterministic System-One decision.
 *
 * Not argmax: a distribution like {simple: .45, standard: .30, structural: .25}
 * has "simple" as its mode, yet a 55% chance the cheap model is out of its
 * depth. We send work to the cheap provider only when the probability mass of
 * cheap-eligible levels clears the bar; everything else stays on the primary.
 */
export function selectRoute(d: ComplexityDistribution & { readonly risk?: number }, options: PolicyOptions): Route {
  if ((d.risk ?? 0) >= MAX_CHEAP_RISK) return 'primary';
  const cheapMass = options.standardRoute === 'cheap' ? d.simple + d.standard : d.simple;
  return cheapMass >= options.minCheapProbability ? 'cheap' : 'primary';
}

/**
 * A short request can be risky ("store the Stripe key in the code"): JEV calls
 * it simple, and it is, for the wrong reason. On scripts/eval-jev.ts the risk
 * Nouls split cleanly (simple prompts <= 0.15, risky >= 0.92), so 0.5 is not
 * a tuned knob.
 */
// ponytail: fixed bar, make it a PolicyOptions field if the eval ever puts cases near it
const MAX_CHEAP_RISK = 0.5;

/**
 * Escalate-only: once a conversation reaches the primary provider it stays
 * there. Bouncing back to the cheap model would throw away the Anthropic
 * prompt cache, which the next escalation would have to rebuild at full price.
 */
export function stickyRoute(current: Route, proposed: Route): Route {
  return current === 'primary' || proposed === 'primary' ? 'primary' : 'cheap';
}
