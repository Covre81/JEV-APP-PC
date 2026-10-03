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
export function selectRoute(d: ComplexityDistribution, options: PolicyOptions): Route {
  const cheapMass = options.standardRoute === 'cheap' ? d.simple + d.standard : d.simple;
  return cheapMass >= options.minCheapProbability ? 'cheap' : 'primary';
}

/**
 * Escalate-only: once a conversation reaches the primary provider it stays
 * there. Bouncing back to the cheap model would throw away the Anthropic
 * prompt cache, which the next escalation would have to rebuild at full price.
 */
export function stickyRoute(current: Route, proposed: Route): Route {
  return current === 'primary' || proposed === 'primary' ? 'primary' : 'cheap';
}
