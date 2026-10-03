import { TIERS, tierRank, type Tier, type TierScores } from './tiers.js';

export interface PolicyInput {
  readonly scores: TierScores;
  /** Minimum sufficiency confidence (0–100) required to accept a tier. */
  readonly threshold: number;
  /** Highest tier the router may choose (normally the tier the client asked for). */
  readonly ceiling: Tier;
  /** Tiers excluded up front (e.g. context too large for the model's window). */
  readonly excluded?: ReadonlySet<Tier>;
}

/**
 * Deterministic System-One → model decision.
 *
 * Rule: walk tiers from cheapest to most capable and take the first one whose
 * sufficiency score clears the threshold. If none does, fall back to the
 * ceiling (fail-up: an uncertain classification must never degrade quality).
 *
 * Pure function: same input, same output. No I/O, no clock, no randomness.
 */
export function selectTier(input: PolicyInput): Tier {
  const { scores, threshold, ceiling, excluded } = input;
  const ceilingRank = tierRank(ceiling);

  for (const tier of TIERS) {
    if (tierRank(tier) > ceilingRank) break;
    if (excluded?.has(tier)) continue;
    if (scores[tier] >= threshold) return tier;
  }
  return ceiling;
}
