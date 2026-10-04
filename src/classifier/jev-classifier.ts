import { request } from 'undici';
import { z } from 'zod';
import { toDistribution, type ComplexityDistribution } from '../domain/complexity.js';
import type { Classification, ClassificationInput, ComplexityClassifier } from './classifier.js';

/**
 * Adapter for TypeSafe JEV (`POST /v1/systemone`).
 *
 * JEV does not generate text: it answers typed questions about a `state` with
 * calibrated probabilities. We ask ONE ordinal `score` question with three
 * levels and keep the full distribution — the policy, not the classifier,
 * decides what to do with uncertainty.
 */
export const QUESTION_ID = 'task_complexity';

const COMPLEXITY_CRITERIA = [
  'Simple and self-contained: answering a question, explaining code, a one-file edit, a rename, formatting, a docstring or a single small unit test, running a known command.',
  'Standard feature work: a bugfix or feature touching a few files, a React Native screen or hook, a Python module with its tests, debugging with a clear reproduction.',
  'Structural or complex: Clean Architecture/SOLID refactors across layers, test-suite design with heavy fixtures or mocking, concurrency, security or performance root causes, migrations, ambiguous requirements.',
] as const;

/** The part of the JEV response the adapter depends on. Unknown fields are tolerated. */
export const JevResponse = z.looseObject({
  answers: z.looseObject({
    [QUESTION_ID]: z.looseObject({
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
});

/** Billed tokens, read leniently: a missing or malformed usage block only loses the cost line. */
const JevUsage = z.looseObject({
  usage: z.looseObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});

export interface JevClassifierOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export class JevClassifier implements ComplexityClassifier {
  readonly name = 'jev';

  constructor(private readonly options: JevClassifierOptions) {}

  async classify(input: ClassificationInput, signal: AbortSignal): Promise<Classification> {
    const res = await request(this.options.apiUrl, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(jevRequestBody(this.options.model, input)),
    });

    const payload: unknown = await res.body.json();
    if (res.statusCode !== 200) {
      throw new Error(`JEV HTTP ${res.statusCode}: ${JSON.stringify(payload).slice(0, 300)}`);
    }

    const usage = JevUsage.safeParse(payload);
    return {
      ...parseJevAnswer(payload),
      ...(usage.success
        ? { usage: { inputTokens: usage.data.usage.input_tokens, outputTokens: usage.data.usage.output_tokens } }
        : {}),
    };
  }
}

/** Request body for one ordinal complexity question. */
export function jevRequestBody(model: string, input: ClassificationInput): object {
  return {
    model,
    state: buildState(input),
    questions: {
      [QUESTION_ID]: {
        type: 'score',
        instructions: 'How complex is this request for an AI coding agent working in the developer repository?',
        criteria: COMPLEXITY_CRITERIA,
      },
    },
  };
}

/** Production parsing: schema check, then levels "0" | "1" | "2" (a missing level counts as 0). */
export function parseJevAnswer(payload: unknown): ComplexityDistribution {
  const { probabilities: p } = JevResponse.parse(payload).answers[QUESTION_ID]!;
  return toDistribution(p['0'] ?? 0, p['1'] ?? 0, p['2'] ?? 0);
}

/**
 * Strict contract check used by scripts/test-jev-real.ts against production.
 * Stricter than parseJevAnswer on purpose: it flags what the adapter would
 * silently tolerate (missing or extra levels, mass that does not sum to 1).
 * Returns human-readable issues; empty means the contract holds.
 */
export function jevContractIssues(payload: unknown): string[] {
  const parsed = JevResponse.safeParse(payload);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `schema: ${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  const p = parsed.data.answers[QUESTION_ID]!.probabilities;
  const issues: string[] = [];
  const keys = Object.keys(p).sort();
  for (const level of ['0', '1', '2']) {
    if (!(level in p)) issues.push(`probabilities: level "${level}" missing (got keys ${JSON.stringify(keys)})`);
  }
  const extra = keys.filter((k) => !['0', '1', '2'].includes(k));
  if (extra.length > 0) issues.push(`probabilities: unexpected levels ${JSON.stringify(extra)}`);
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) issues.push(`probabilities: sum is ${sum.toFixed(4)}, expected 1 ± 0.02`);
  return issues;
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
