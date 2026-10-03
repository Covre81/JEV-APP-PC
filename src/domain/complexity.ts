/**
 * JEV's answer to "how complex is this task?" as a probability distribution
 * over three ordinal levels (JEV score levels 0/1/2 = levels 1/2/3 in docs):
 *
 *   simple     — level 1: questions, explanations, one-file edits, renames
 *   standard   — level 2: a feature or bugfix across a few files, with tests
 *   structural — level 3: Clean Architecture refactors, heavy test design,
 *                concurrency/security/performance root causes
 *
 * Values are probabilities in [0, 1] that sum to 1.
 */
export interface ComplexityDistribution {
  readonly simple: number;
  readonly standard: number;
  readonly structural: number;
}

/** Normalizes non-negative weights into a distribution; rejects an all-zero input. */
export function toDistribution(simple: number, standard: number, structural: number): ComplexityDistribution {
  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const [a, b, c] = [clamp(simple), clamp(standard), clamp(structural)];
  const total = a + b + c;
  if (total === 0) throw new Error('complexity distribution has no mass');
  return { simple: a / total, standard: b / total, structural: c / total };
}
