import type { TierScores } from '../domain/tiers.js';
import type { ClassificationInput, ComplexityClassifier } from './classifier.js';

/**
 * OFFLINE MOCK — deterministic keyword/size heuristic.
 *
 * Exists for local development without a TypeSafe key and as the reference
 * fixture in tests. It is NOT a substitute for JEV in production: keyword
 * matching has no notion of calibration and is trivially fooled.
 */
const TRIVIAL =
  /\b(typo|rename|format|lint|explain|what (is|does)|how do i|list|print|comment|docstring|bump|changelog)\b/i;
const HARD =
  /\b(architect\w*|refactor\w*|design|race condition|deadlock|concurren\w*|security|vulnerab\w*|performance|optimi[sz]\w*|migrat\w*|distributed|root cause|algorithm\w*|trade-?offs?)\b/i;

const LONG_PROMPT_CHARS = 2_000;
const LARGE_CONTEXT_TOKENS = 100_000;

export class HeuristicClassifier implements ComplexityClassifier {
  readonly name = 'heuristic';

  classify(input: ClassificationInput): Promise<TierScores> {
    let haiku = 60;
    let sonnet = 90;

    if (TRIVIAL.test(input.text)) haiku += 30;
    if (HARD.test(input.text)) {
      haiku -= 45;
      sonnet -= 30;
    }
    if (input.text.length > LONG_PROMPT_CHARS) {
      haiku -= 20;
      sonnet -= 10;
    }
    if (input.estimatedInputTokens > LARGE_CONTEXT_TOKENS) haiku -= 30;

    const clamp = (n: number) => Math.min(100, Math.max(0, n));
    const h = clamp(haiku);
    return Promise.resolve({ haiku: h, sonnet: Math.max(h, clamp(sonnet)), opus: 100 });
  }
}
