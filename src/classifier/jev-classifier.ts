import { request } from 'undici';
import { z } from 'zod';
import { toDistribution, type ComplexityDistribution } from '../domain/complexity.js';
import type { ClassificationInput, ComplexityClassifier } from './classifier.js';

/**
 * Adapter for TypeSafe JEV (`POST /v1/systemone`).
 *
 * JEV does not generate text: it answers typed questions about a `state` with
 * calibrated probabilities. We ask ONE ordinal `score` question with three
 * levels and keep the full distribution — the policy, not the classifier,
 * decides what to do with uncertainty.
 */
const QUESTION_ID = 'task_complexity';

const COMPLEXITY_CRITERIA = [
  'Simple and self-contained: answering a question, explaining code, a one-file edit, a rename, formatting, a docstring or a single small unit test, running a known command.',
  'Standard feature work: a bugfix or feature touching a few files, a React Native screen or hook, a Python module with its tests, debugging with a clear reproduction.',
  'Structural or complex: Clean Architecture/SOLID refactors across layers, test-suite design with heavy fixtures or mocking, concurrency, security or performance root causes, migrations, ambiguous requirements.',
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

  async classify(input: ClassificationInput, signal: AbortSignal): Promise<ComplexityDistribution> {
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
            instructions: 'How complex is this request for an AI coding agent working in the developer repository?',
            criteria: COMPLEXITY_CRITERIA,
          },
        },
      }),
    });

    const payload: unknown = await res.body.json();
    if (res.statusCode !== 200) {
      throw new Error(`JEV HTTP ${res.statusCode}: ${JSON.stringify(payload).slice(0, 300)}`);
    }

    const { probabilities: p } = JevResponse.parse(payload).answers[QUESTION_ID]!;
    return toDistribution(p['0'] ?? 0, p['1'] ?? 0, p['2'] ?? 0);
  }
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
