import type { ComplexityDistribution } from '../domain/complexity.js';

/** Signals extracted from a Messages request, independent of any vendor. */
export interface ClassificationInput {
  /** Human-typed text of the latest turn, system-reminders stripped, truncated. */
  readonly text: string;
  readonly turnCount: number;
  readonly toolCount: number;
  readonly estimatedInputTokens: number;
}

/** A distribution plus, when the classifier is a paid API, the tokens that call billed. */
export type Classification = ComplexityDistribution & {
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** P(the turn is security-sensitive or destructive); a high value vetoes the cheap route. */
  readonly risk?: number;
  /** Each risk Noul by question id; `risk` is their max. */
  readonly riskScores?: Readonly<Record<string, number>>;
  /** Versioned model that answered (an alias like `jev-latest` resolves to it). */
  readonly model?: string;
  /** P(a written reply alone answers the turn); asked only when the Gemini tier is on. */
  readonly textOnly?: number;
};

/**
 * System One port. Implementations must be fast (sub-second), side-effect
 * free, and either resolve with a distribution or reject — never guess silently.
 */
export interface ComplexityClassifier {
  readonly name: string;
  classify(input: ClassificationInput, signal: AbortSignal): Promise<Classification>;
}
