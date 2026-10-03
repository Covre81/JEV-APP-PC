import { request } from 'undici';
import { z } from 'zod';
import type { TierScores } from '../domain/tiers.js';
import type { ClassificationInput, ComplexityClassifier } from './classifier.js';

/**
 * Adapter for TypeSafe JEV (`POST /v1/systemone`).
 *
 * JEV does not generate text: it answers typed questions about a `state` with
 * calibrated probabilities. We ask ONE ordinal `score` question whose levels
 * are the tiers, then turn the level distribution into cumulative
 * sufficiency: P(haiku suffices) = p0, P(sonnet suffices) = p0 + p1, opus = 1.
 */
const QUESTION_ID = 'required_tier';

const TIER_CRITERIA = [
  'Trivial or mechanical: a question, an explanation, a one-file edit, a rename, formatting, running a known command. No design decisions.',
  'Standard engineering: a multi-file feature or bugfix in a known codebase, writing tests, debugging with a clear reproduction.',
  'Hard reasoning: architecture or cross-cutting refactors, concurrency/security/performance root-cause analysis, ambiguous requirements, novel algorithms, long autonomous work.',
] as const;

const JevResponse = z.looseObject({
  answers: z.looseObject({
    [QUESTION_ID]: z.looseObject({
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
});

export interface JevClassifierOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export class JevClassifier implements ComplexityClassifier {
  readonly name = 'jev';

  constructor(private readonly options: JevClassifierOptions) {}

  async classify(input: ClassificationInput, signal: AbortSignal): Promise<TierScores> {
    const res = await request(this.options.apiUrl, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        state: buildState(input),
        questions: {
          [QUESTION_ID]: {
            type: 'score',
            instructions:
              'What is the least capable tier of AI coding assistant that will complete this developer request correctly on the first attempt?',
            criteria: TIER_CRITERIA,
          },
        },
      }),
    });

    const payload: unknown = await res.body.json();
    if (res.statusCode !== 200) {
      throw new Error(`JEV HTTP ${res.statusCode}: ${JSON.stringify(payload).slice(0, 300)}`);
    }

    const { probabilities } = JevResponse.parse(payload).answers[QUESTION_ID]!;
    return scoresFromDistribution(probabilities);
  }
}

/** Ordinal level distribution → cumulative sufficiency scores (0–100). */
export function scoresFromDistribution(probabilities: Readonly<Record<string, number>>): TierScores {
  const p0 = probabilities['0'] ?? 0;
  const p1 = probabilities['1'] ?? 0;
  const pct = (p: number) => Math.round(Math.min(1, Math.max(0, p)) * 100);
  return { haiku: pct(p0), sonnet: pct(p0 + p1), opus: 100 };
}

/** JEV consumes unstructured state; give it the request plus the cheap structural signals. */
export function buildState(input: ClassificationInput): string {
  return [
    `Developer request to an AI coding agent:`,
    input.text,
    ``,
    `Context: conversation turn ${input.turnCount}, ${input.toolCount} tools available, ~${input.estimatedInputTokens} input tokens.`,
  ].join('\n');
}
