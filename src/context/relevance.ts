import { z } from 'zod';
import type { GraphData, GraphCommunity } from './graph-source.js';
import { parseJev, type JevClient } from './jev-client.js';

export const STAGE1_INSTRUCTIONS = 'Which of these code/project communities is most relevant to the prompt?';

/** JEV's Choice limit is 255 options; 240 leaves headroom. */
const MAX_CHOICES = 240;
const TOP_COMMUNITIES = 2;

/** Probabilities come back keyed by the criteria keys we sent. */
const JevChoiceResponse = z.looseObject({
  answers: z.looseObject({
    relevant_community: z.looseObject({
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
});

export interface SelectedCommunity {
  readonly graph: GraphData;
  readonly community: GraphCommunity;
  readonly p: number;
}

/**
 * Stage 1: one JEV Choice per graph (chunked at 240 options, e.g. 300
 * communities → 2 requests), every graph in parallel; keeps the 2 best
 * communities of each graph.
 *
 * The API takes `criteria` as a {key: description} dictionary and answers
 * `probabilities` by key (a list is rejected with 422). A Choice
 * distribution sums to 1 within one call, so p is only compared inside a
 * graph; stage 2's Nouls are what compare across graphs.
 */
export async function rankCommunities(options: {
  readonly client: JevClient;
  readonly model: string;
  readonly prompt: string;
  readonly graphs: readonly GraphData[];
  readonly signal: AbortSignal;
}): Promise<readonly SelectedCommunity[]> {
  const perGraph = await Promise.all(
    options.graphs.map(async (graph) => {
      const batches: GraphCommunity[][] = [];
      for (let i = 0; i < graph.communities.length; i += MAX_CHOICES) batches.push(graph.communities.slice(i, i + MAX_CHOICES));

      const scored = await Promise.all(
        batches.map(async (batch) => {
          const byKey = new Map(batch.map((community, i) => [`k${i}`, community]));
          const payload = await options.client.postSystemOne(
            {
              model: options.model,
              state: `User prompt:\n${options.prompt}`,
              questions: {
                relevant_community: {
                  type: 'choice',
                  instructions: STAGE1_INSTRUCTIONS,
                  criteria: Object.fromEntries([...byKey].map(([key, c]) => [key, c.description || `community ${c.id}`])),
                },
              },
            },
            options.signal,
          );
          const { probabilities } = parseJev(JevChoiceResponse, payload).answers.relevant_community;
          return [...byKey].map(([key, community]) => ({ community, p: probabilities[key] ?? 0 }));
        }),
      );

      return scored
        .flat()
        .sort((a, b) => b.p - a.p)
        .slice(0, TOP_COMMUNITIES)
        .map((r) => ({ graph, community: r.community, p: r.p }));
    }),
  );
  return perGraph.flat();
}
