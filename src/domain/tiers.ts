/**
 * Capability tiers, ordered from cheapest to most capable.
 * The order of this tuple IS the cost order — every policy decision relies on it.
 */
export const TIERS = ['haiku', 'sonnet', 'opus'] as const;

export type Tier = (typeof TIERS)[number];

/**
 * Confidence (0–100) that a given tier is *sufficient* to solve the task.
 * This is the contract between any classifier (JEV, heuristic, future ones)
 * and the routing policy. Example: { haiku: 90, sonnet: 97, opus: 100 }.
 */
export type TierScores = Readonly<Record<Tier, number>>;

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export function minTier(a: Tier, b: Tier): Tier {
  return tierRank(a) <= tierRank(b) ? a : b;
}
