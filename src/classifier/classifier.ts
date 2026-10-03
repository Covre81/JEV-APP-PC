import type { TierScores } from '../domain/tiers.js';

/** Signals extracted from a Messages request, independent of any vendor. */
export interface ClassificationInput {
  /** Human-typed text of the latest turn, system-reminders stripped, truncated. */
  readonly text: string;
  readonly turnCount: number;
  readonly toolCount: number;
  readonly estimatedInputTokens: number;
}

/**
 * System One port. Implementations must be fast (sub-second), side-effect
 * free, and either resolve with scores or reject — never guess silently.
 */
export interface ComplexityClassifier {
  readonly name: string;
  classify(input: ClassificationInput, signal: AbortSignal): Promise<TierScores>;
}
