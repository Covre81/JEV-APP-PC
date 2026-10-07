import { z } from 'zod';
import type { GraphData, GraphCommunity } from './graph-source.js';
import type { JevClient } from './jev-client.js';

const JevChoiceResponseSchema = z.looseObject({
  answers: z.looseObject({
    relevant_community: z.looseObject({
      probabilities: z.record(z.string(), z.number()),
    }),
  }),
});

export interface SelectedCommunity {
  readonly graph: GraphData;
  readonly community: GraphCommunity;
  readonly p: number;
}

/**
 * Runs JEV Choice to select the 2 most relevant communities for each graph.
 * If a graph has more than 240 communities, they are chunked into batches of up to 240
 * options, resulting in multiple parallel JEV calls (e.g., 300 communities → 2 requests).
 */
export async function rankCommunities(options: {
  readonly client: JevClient;
  readonly model: string;
  readonly prompt: string;
  readonly graphs: readonly GraphData[];
  readonly signal: AbortSignal;
}): Promise<readonly SelectedCommunity[]> {
  const results: SelectedCommunity[] = [];

  for (const graph of options.graphs) {
    if (graph.communities.length === 0) continue;

    // Chunk communities into batches of up to 240
    const batches: GraphCommunity[][] = [];
    for (let i = 0; i < graph.communities.length; i += 240) {
      batches.push(graph.communities.slice(i, i + 240));
    }

    // Run parallel JEV Choice calls for each batch
    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const choiceMap = new Map<string, GraphCommunity>();
        const choices: string[] = [];

        for (const comm of batch) {
          const choiceLabel = `Community ${comm.id}: ${comm.description}`;
          choices.push(choiceLabel);
          choiceMap.set(choiceLabel, comm);
        }

        const requestBody = {
          model: options.model,
          state: `User prompt:\n${options.prompt}`,
          questions: {
            relevant_community: {
              type: 'choice',
              instructions: 'Which of these code/project communities are most relevant to the prompt?',
              choices,
            },
          },
        };

        const rawPayload = await options.client.postSystemOne(requestBody, options.signal);
        const parsed = JevChoiceResponseSchema.parse(rawPayload);
        const probs = parsed.answers.relevant_community.probabilities;

        const resultsForBatch: { community: GraphCommunity; p: number }[] = [];
        for (const [label, p] of Object.entries(probs)) {
          if (choiceMap.has(label)) {
            resultsForBatch.push({
              community: choiceMap.get(label)!,
              p,
            });
          }
        }
        return resultsForBatch;
      })
    );

    // Combine all batch community results and pick the top 2 best overall for this graph
    const combinedResults = batchResults.flat();
    combinedResults.sort((a, b) => b.p - a.p);

    const bestTwo = combinedResults.slice(0, 2);
    for (const r of bestTwo) {
      results.push({
        graph,
        community: r.community,
        p: r.p,
      });
    }
  }

  return results;
}
