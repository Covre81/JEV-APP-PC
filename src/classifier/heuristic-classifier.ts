import { toDistribution, type ComplexityDistribution } from '../domain/complexity.js';
import type { ClassificationInput, ComplexityClassifier } from './classifier.js';

/**
 * OFFLINE MOCK — deterministic keyword/size heuristic.
 *
 * Exists for local development without a TypeSafe key and as the reference
 * fixture in tests. It is NOT a substitute for JEV in production: keyword
 * matching has no notion of calibration and is trivially fooled.
 */
const SIMPLE =
  /\b(typo|rename|format|lint|explain|what (is|does)|how do i|list|print|comment|docstring|bump|changelog)\b/i;
const STRUCTURAL =
  /\b(architect\w*|clean architecture|solid|refactor\w*|design|race condition|deadlock|concurren\w*|security|vulnerab\w*|performance|optimi[sz]\w*|migrat\w*|root cause|trade-?offs?|test suite|fixtures?|mock\w*)\b/i;

const LONG_PROMPT_CHARS = 2_000;
const LARGE_CONTEXT_TOKENS = 100_000;

export class HeuristicClassifier implements ComplexityClassifier {
  readonly name = 'heuristic';

  classify(input: ClassificationInput): Promise<ComplexityDistribution> {
    let simple = 3;
    let standard = 5;
    let structural = 2;

    if (SIMPLE.test(input.text)) simple += 30;
    if (STRUCTURAL.test(input.text)) structural += 30;
    if (input.text.length > LONG_PROMPT_CHARS) structural += 5;
    if (input.estimatedInputTokens > LARGE_CONTEXT_TOKENS) standard += 5;

    return Promise.resolve(toDistribution(simple, standard, structural));
  }
}
