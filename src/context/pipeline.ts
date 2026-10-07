import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { getMachineOrigin } from './origin.js';
import { searchMemory, type MemoryHit } from './memory-source.js';
import { getGraphSources, type GraphData, type GraphCommunity } from './graph-source.js';
import { JevClient, JevHttpError } from './jev-client.js';
import { rankCommunities, type SelectedCommunity } from './relevance.js';
import { scoreCandidates, type Candidate, type ScoredCandidate } from './select.js';
import { recordContextRun, type ContextCandidateInput } from './log.js';
import { openTelemetryDb } from '../telemetry/db.js';
import { defaultTelemetryDbPath } from '../paths.js';

// Schema for input from stdin
const StdinSchema = z.looseObject({
  prompt: z.string(),
  session_id: z.string(),
  cwd: z.string(),
  transcript_path: z.string().optional(),
});

export type ContextInput = z.infer<typeof StdinSchema>;

export interface PipelineConfig {
  readonly mode: 'inject' | 'shadow' | 'off';
  readonly lCurrent: number;
  readonly lOther: number;
  readonly maxItems: number;
  readonly maxChars: number;
  readonly timeoutMs: number;
  readonly graphRoot?: string | undefined;
  readonly aiMemoryBin: string;
  readonly apiKey?: string | undefined;
  readonly apiUrl: string;
  readonly model: string;
}

export interface PipelineResult {
  readonly outcome: 'ok' | 'skipped_origin' | 'config_error' | 'partial' | 'source_error' | 'jev_error' | 'timeout';
  readonly stdout: string;
}

export async function runPipeline(
  rawInput: unknown,
  config: PipelineConfig
): Promise<PipelineResult> {
  // 1. Validate stdin
  const parsedInput = StdinSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    // Stdin inválido: sai sem gravar (as per instructions)
    throw new Error('invalid_stdin');
  }
  const input = parsedInput.data;

  const pipelineVersionInput = JSON.stringify({
    lCurrent: config.lCurrent,
    lOther: config.lOther,
    maxItems: config.maxItems,
    maxChars: config.maxChars,
    stage1Question: 'Which of these code/project communities are most relevant to the prompt?',
    stage2Question: 'Is this item relevant to the user prompt?',
  });
  const pipelineVersion = createHash('sha256').update(pipelineVersionInput).digest('hex').slice(0, 12);

  // 2. Check for machine origin
  const machineOrigin = getMachineOrigin(input.prompt);
  if (machineOrigin) {
    try {
      const dbPath = process.env['TELEMETRY_DB_PATH'] ?? defaultTelemetryDbPath();
      if (existsSync(dirname(dbPath))) {
        const db = openTelemetryDb(dbPath);
        try {
          recordContextRun(
            db,
            {
              sessionId: input.session_id,
              prompt: input.prompt,
              mode: config.mode,
              outcome: 'skipped_origin',
              pipelineVersion,
              injected: false,
              injectedChars: 0,
            },
            []
          );
        } finally {
          db.close();
        }
      }
    } catch {
      // Ignored db error
    }
    return { outcome: 'skipped_origin', stdout: '' };
  }

  if (config.mode === 'off') {
    return { outcome: 'ok', stdout: '' };
  }

  // 3. Check for API key configuration
  if (!config.apiKey) {
    try {
      const dbPath = process.env['TELEMETRY_DB_PATH'] ?? defaultTelemetryDbPath();
      if (existsSync(dirname(dbPath))) {
        const db = openTelemetryDb(dbPath);
        try {
          recordContextRun(
            db,
            {
              sessionId: input.session_id,
              prompt: input.prompt,
              mode: config.mode,
              outcome: 'config_error',
              pipelineVersion,
              injected: false,
              injectedChars: 0,
            },
            []
          );
        } finally {
          db.close();
        }
      }
    } catch {
      // Ignored db error
    }
    return { outcome: 'config_error', stdout: '' };
  }

  // Setup AbortController for global timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  let finalOutcome: 'ok' | 'partial' | 'source_error' | 'jev_error' | 'timeout' = 'ok';
  let memoryHits: readonly MemoryHit[] = [];
  let graphSources: readonly GraphData[] = [];
  let memoryFailed = false;
  let graphFailed = false;

  // 4. Fetch memory and graph sources in parallel
  try {
    const memoryPromise = (async () => {
      try {
        return await searchMemory({
          bin: config.aiMemoryBin,
          cwd: input.cwd,
          prompt: input.prompt,
          timeoutMs: config.timeoutMs,
          signal: controller.signal,
        });
      } catch (err) {
        memoryFailed = true;
        return [];
      }
    })();

    const graphPromise = (async () => {
      try {
        if (!config.graphRoot) return [];
        return getGraphSources(config.graphRoot, input.cwd);
      } catch (err) {
        graphFailed = true;
        return [];
      }
    })();

    const [memResult, graphResult] = await Promise.all([memoryPromise, graphPromise]);
    memoryHits = memResult;
    graphSources = graphResult;

    if (memoryFailed && graphFailed) {
      finalOutcome = 'source_error';
    } else if (memoryFailed || graphFailed) {
      finalOutcome = 'partial';
    }
  } catch (err: any) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      finalOutcome = 'timeout';
    } else {
      finalOutcome = 'source_error';
    }
  }

  const allCandidates: ScoredCandidate[] = [];
  const evaluatedCandidates: ContextCandidateInput[] = [];

  if (finalOutcome !== 'timeout' && finalOutcome !== 'source_error') {
    const client = new JevClient({ apiUrl: config.apiUrl, apiKey: config.apiKey });

    try {
      // 5. JEV Stage 1 Choice (rank communities)
      let selectedCommunities: readonly SelectedCommunity[] = [];
      if (graphSources.length > 0) {
        selectedCommunities = await rankCommunities({
          client,
          model: config.model,
          prompt: input.prompt,
          graphs: graphSources,
          signal: controller.signal,
        });
      }

      // 6. Build Candidate List
      const candidatesList: Candidate[] = [];
      let nextId = 0;

      // Add Memory Candidates
      for (const hit of memoryHits) {
        candidatesList.push({
          id: `c${nextId++}`,
          type: 'memory',
          path: hit.path,
          title: hit.title,
          content: hit.snippet,
          isCurrent: true, // Memory is always current project
          project: '', // Filled in later or omitted for memory
        });
      }

      // Add Graph Candidates (up to 10 nodes of top 2 selected communities of each graph)
      for (const sel of selectedCommunities) {
        const topNodes = sel.community.topNodes.slice(0, 10);
        for (const node of topNodes) {
          candidatesList.push({
            id: `c${nextId++}`,
            type: 'graph',
            path: sel.community.id,
            content: node.label,
            isCurrent: sel.graph.isCurrent,
            project: sel.graph.project,
            extra: {
              communityId: sel.community.id,
              nodeId: node.id,
              nodeLabel: node.label,
            },
          });
        }
      }

      // 7. JEV Stage 2 Nouls (score candidates)
      const scoredCandidates = await scoreCandidates({
        client,
        model: config.model,
        prompt: input.prompt,
        candidates: candidatesList,
        signal: controller.signal,
      });

      allCandidates.push(...scoredCandidates);
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        finalOutcome = 'timeout';
      } else if (err instanceof JevHttpError || err.name === 'ZodError') {
        finalOutcome = 'jev_error';
      } else {
        finalOutcome = 'jev_error';
      }
    }
  }

  clearTimeout(timeoutId);

  // If timeout was triggered during execution, override outcome
  if (controller.signal.aborted) {
    finalOutcome = 'timeout';
  }

  // 8. Thresholding, Grouping, and Filtering
  const selectedMemoryItems: ScoredCandidate[] = [];
  const selectedGraphNodes: ScoredCandidate[] = [];

  for (const cand of allCandidates) {
    const threshold = cand.isCurrent ? config.lCurrent : config.lOther;
    const isSelected = cand.p >= threshold;

    if (isSelected) {
      if (cand.type === 'memory') {
        selectedMemoryItems.push(cand);
      } else {
        selectedGraphNodes.push(cand);
      }
    }
  }

  // Group graph nodes by project + community
  const groupedGraphItems: {
    project: string;
    communityId: string;
    labels: string[];
    maxP: number;
  }[] = [];

  for (const node of selectedGraphNodes) {
    const commId = node.extra?.communityId || '';
    const proj = node.project;
    let group = groupedGraphItems.find((g) => g.project === proj && g.communityId === commId);
    if (!group) {
      group = {
        project: proj,
        communityId: commId,
        labels: [],
        maxP: 0,
      };
      groupedGraphItems.push(group);
    }
    group.labels.push(node.content);
    if (node.p > group.maxP) {
      group.maxP = node.p;
    }
  }

  // Format final list of items with their scored P
  interface FormattedItem {
    readonly text: string;
    readonly p: number;
    readonly rawItems: readonly ScoredCandidate[];
  }

  const finalFormattedList: FormattedItem[] = [];

  // Memory items
  for (const mem of selectedMemoryItems) {
    finalFormattedList.push({
      text: `[memória] ${mem.title || mem.path} (${mem.path}): ${mem.content}`,
      p: mem.p,
      rawItems: [mem],
    });
  }

  // Grouped graph items
  for (const group of groupedGraphItems) {
    // Unique and sort labels
    const uniqueLabels = Array.from(new Set(group.labels)).join(', ');
    finalFormattedList.push({
      text: `[grafo] ${group.project} › ${group.communityId}: ${uniqueLabels}`,
      p: group.maxP,
      rawItems: selectedGraphNodes.filter(
        (n) => n.project === group.project && n.extra?.communityId === group.communityId
      ),
    });
  }

  // Sort final items by p descending
  finalFormattedList.sort((a, b) => b.p - a.p);

  // Apply maximum items and character limit
  const finalSelectedStrings: string[] = [];
  const injectedCandidateIds = new Set<string>();
  let currentChars = 0;

  for (const item of finalFormattedList) {
    if (finalSelectedStrings.length >= config.maxItems) break;
    const additionalLength = item.text.length + (finalSelectedStrings.length > 0 ? 1 : 0);
    if (currentChars + additionalLength > config.maxChars) break;

    finalSelectedStrings.push(item.text);
    currentChars += additionalLength;
    for (const raw of item.rawItems) {
      injectedCandidateIds.add(raw.id);
    }
  }

  const injectedContextStr = finalSelectedStrings.join('\n');
  const hasInjected = finalSelectedStrings.length > 0;

  // Build list of evaluated candidates for DB log
  for (const cand of allCandidates) {
    evaluatedCandidates.push({
      type: cand.type,
      path: cand.path,
      title: cand.title || null,
      content: cand.content,
      p: cand.p,
      injected: injectedCandidateIds.has(cand.id),
    });
  }

  // 9. Db Logging
  try {
    const dbPath = process.env['TELEMETRY_DB_PATH'] ?? defaultTelemetryDbPath();
    if (existsSync(dirname(dbPath))) {
      const db = openTelemetryDb(dbPath);
      try {
        recordContextRun(
          db,
          {
            sessionId: input.session_id,
            prompt: input.prompt,
            mode: config.mode,
            outcome: finalOutcome,
            pipelineVersion,
            injected: hasInjected,
            injectedChars: injectedContextStr.length,
          },
          evaluatedCandidates
        );
      } finally {
        db.close();
      }
    }
  } catch (err: any) {
    process.stderr.write(`SQLite failure: ${err.message}\n`);
  }

  // 10. Stdout Output
  let stdoutResult = '';
  if (config.mode === 'inject' && hasInjected) {
    stdoutResult = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: injectedContextStr,
      },
    });
  }

  return {
    outcome: finalOutcome,
    stdout: stdoutResult,
  };
}

function dirname(path: string): string {
  return path.substring(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}
