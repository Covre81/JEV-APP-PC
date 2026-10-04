/**
 * Can the cheap model drive Claude Code's tool loop? Runs Read/Edit tasks
 * through the real OpenAICompatibleProvider against CHEAP_BASE_URL.
 *
 *   npx tsx scripts/bench.ts [--env <file>] [--trials 3] [--task fix-bug,rename]
 *                            [--pad-kb 16] [--max-steps 8] [--min-success 0.8]
 *                            [--model <id>] [--json]
 *
 * Needs CHEAP_BASE_URL, CHEAP_API_KEY (any non-empty string for Ollama) and
 * CHEAP_MODEL. Calls the real provider: never runs in CI.
 * Exit 0 = success rate >= --min-success, 1 = below, 2 = setup error.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../src/env.js';
import { OpenAICompatibleProvider } from '../src/providers/openai/provider.js';
import { renderSummary, runTrial, summarize, TASKS, type TrialResult } from './bench/harness.js';

const Env = z.object({
  CHEAP_BASE_URL: z.url(),
  CHEAP_API_KEY: z.string().min(1),
  CHEAP_MODEL: z.string().min(1),
  CHEAP_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8_192),
  CHEAP_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

const Args = z.object({
  trials: z.coerce.number().int().positive(),
  padKb: z.coerce.number().int().min(0),
  maxSteps: z.coerce.number().int().positive(),
  minSuccess: z.coerce.number().min(0).max(1),
});

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      trials: { type: 'string', default: '3' },
      task: { type: 'string' },
      'pad-kb': { type: 'string', default: '16' },
      'max-steps': { type: 'string', default: '8' },
      'min-success': { type: 'string', default: '0.8' },
      model: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  const envFile = loadEnv(values.env);
  const env = Env.safeParse(process.env);
  const args = Args.safeParse({
    trials: values.trials,
    padKb: values['pad-kb'],
    maxSteps: values['max-steps'],
    minSuccess: values['min-success'],
  });
  const wanted = values.task?.split(',').map((t) => t.trim());
  const tasks = wanted ? TASKS.filter((t) => wanted.includes(t.id)) : TASKS;
  const problems = [
    ...(env.success ? [] : env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...(args.success ? [] : args.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`)),
    ...(tasks.length === 0 ? [`--task: none of ${values.task} exist (${TASKS.map((t) => t.id).join(', ')})`] : []),
  ];
  if (!env.success || !args.success || problems.length > 0) {
    console.error(`Setup error (env file: ${envFile ?? 'none'}):`);
    for (const p of problems) console.error(`  ${p}`);
    return 2;
  }

  const model = values.model ?? env.data.CHEAP_MODEL;
  const provider = new OpenAICompatibleProvider({
    baseUrl: env.data.CHEAP_BASE_URL,
    apiKey: env.data.CHEAP_API_KEY,
    model,
    maxOutputTokens: env.data.CHEAP_MAX_OUTPUT_TOKENS,
    timeoutMs: env.data.CHEAP_TIMEOUT_MS,
  });
  const { trials, padKb, maxSteps, minSuccess } = args.data;
  const log = values.json ? () => {} : (line: string) => console.error(line);
  log(`${provider.name} model=${model} tasks=${tasks.map((t) => t.id).join(',')} trials=${trials} pad=${padKb}KB`);

  // Sequential on purpose: a local model on one GPU/CPU would only queue
  // parallel requests, and latency per trial is part of the result.
  const results: TrialResult[] = [];
  for (const task of tasks) {
    for (let i = 1; i <= trials; i++) {
      const r = await runTrial(provider, task, {
        maxSteps,
        padKb,
        maxTokens: Math.min(4_096, env.data.CHEAP_MAX_OUTPUT_TOKENS),
        stepTimeoutMs: env.data.CHEAP_TIMEOUT_MS + 5_000,
      });
      log(`  ${task.id} #${i}: ${r.outcome} in ${r.steps} steps, ${r.latencyMs} ms [${r.toolCalls.join(' ')}]`);
      results.push(r);
    }
  }

  const summary = summarize(model, results);
  console.log(values.json ? JSON.stringify(summary, null, 2) : `\n${renderSummary(summary, minSuccess)}`);
  return summary.successRate >= minSuccess ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 2;
  },
);
