import { z } from 'zod';
import { runPipeline, type PipelineConfig } from './pipeline.js';

const HookConfigSchema = z.looseObject({
  CONTEXT_MODE: z.enum(['inject', 'shadow', 'off']).default('inject'),
  CONTEXT_L_CURRENT: z.coerce.number().default(0.8),
  CONTEXT_L_OTHER: z.coerce.number().default(0.9),
  CONTEXT_MAX_ITEMS: z.coerce.number().int().default(5),
  CONTEXT_MAX_CHARS: z.coerce.number().int().default(1500),
  CONTEXT_TIMEOUT_MS: z.coerce.number().int().default(3000),
  CONTEXT_GRAPH_ROOT: z.string().optional(),
  CONTEXT_AI_MEMORY_BIN: z.string().default('ai-memory'),
  TYPESAFE_API_KEY: z.string().optional(),
  JEV_API_URL: z.string().default('https://api.typesafe.ai/v1/systemone'),
  JEV_MODEL: z.string().default('jev-1.13.0'),
});

export async function runContextHook(explicitEnvFile?: string): Promise<number> {
  try {
    // 1. Parse config (using custom schema)
    const rawConfig = HookConfigSchema.parse(process.env);

    const config: PipelineConfig = {
      mode: rawConfig.CONTEXT_MODE,
      lCurrent: rawConfig.CONTEXT_L_CURRENT,
      lOther: rawConfig.CONTEXT_L_OTHER,
      maxItems: rawConfig.CONTEXT_MAX_ITEMS,
      maxChars: rawConfig.CONTEXT_MAX_CHARS,
      timeoutMs: rawConfig.CONTEXT_TIMEOUT_MS,
      graphRoot: rawConfig.CONTEXT_GRAPH_ROOT,
      aiMemoryBin: rawConfig.CONTEXT_AI_MEMORY_BIN,
      apiKey: rawConfig.TYPESAFE_API_KEY,
      apiUrl: rawConfig.JEV_API_URL,
      model: rawConfig.JEV_MODEL,
    };

    // 2. Read stdin
    let inputStr = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      inputStr += chunk;
    }

    if (inputStr.startsWith('\ufeff')) {
      inputStr = inputStr.slice(1);
    }

    if (!inputStr.trim()) {
      process.stderr.write('[context] Empty stdin received\n');
      return 0; // exit 0 without saving
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (err: any) {
      process.stderr.write(`[context] Invalid JSON on stdin: ${err.message}\n`);
      return 0; // exit 0 without saving
    }

    // 3. Run Pipeline
    const result = await runPipeline(rawInput, config);

    // 4. Output to stdout and write status/diagnostics to stderr if needed
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }

    if (result.outcome !== 'ok' && result.outcome !== 'skipped_origin') {
      process.stderr.write(`[context] Pipeline completed with outcome: ${result.outcome}\n`);
    }

    return 0;
  } catch (err: any) {
    process.stderr.write(`[context] Uncaught pipeline error: ${err.message}\n`);
    return 0; // Always exit 0 as per guidelines
  }
}
