/**
 * One real call to TypeSafe JEV (POST /v1/systemone) to check that the
 * production response still matches the adapter's contract.
 *
 *   npx tsx scripts/test-jev-real.ts [--env <file>] [--prompt "<text>"]
 *
 * Needs TYPESAFE_API_KEY (JEV_API_URL and JEV_MODEL optional). Exactly one JEV
 * call. Never runs in CI. Exit 0 = contract holds, 1 = it broke, 2 = setup error.
 */
import { parseArgs } from 'node:util';
import { request } from 'undici';
import { z } from 'zod';
import {
  jevContractIssues,
  jevRequestBody,
  parseJevAnswer,
} from '../src/classifier/jev-classifier.js';
import { loadEnv } from '../src/env.js';

const Env = z.object({
  TYPESAFE_API_KEY: z.string().min(1),
  JEV_API_URL: z.url().default('https://api.typesafe.ai/v1/systemone'),
  JEV_MODEL: z.string().min(1).default('jev-latest'),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
});

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      prompt: { type: 'string', default: 'rename the function foo to bar in utils.ts' },
    },
  });
  const envFile = loadEnv(values.env);
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(`Setup error (env file: ${envFile ?? 'none'}):`);
    for (const i of env.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
    return 2;
  }
  const { TYPESAFE_API_KEY: apiKey, JEV_API_URL: apiUrl, JEV_MODEL: model, JEV_TIMEOUT_MS: timeoutMs } = env.data;
  const input = { text: values.prompt, turnCount: 1, toolCount: 20, estimatedInputTokens: 20_000 };

  console.log(`POST ${apiUrl}  model=${model}  env=${envFile ?? 'shell'}`);

  // 1. Raw call: see exactly what production returns, independent of our parser.
  const started = performance.now();
  const res = await request(apiUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(jevRequestBody(model, input)),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.body.text();
  const rawMs = Math.round(performance.now() - started);
  console.log(`\nHTTP ${res.statusCode} in ${rawMs} ms (router timeout JEV_TIMEOUT_MS=${timeoutMs})`);
  console.log(`content-type: ${String(res.headers['content-type'])}`);
  console.log('\n--- raw body ---');
  console.log(text);
  console.log('--- end ---\n');

  if (res.statusCode !== 200) {
    console.error(`FAIL: HTTP ${res.statusCode}. Check the key, URL and model before the schema.`);
    return 1;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error('FAIL: body is not JSON.');
    return 1;
  }

  // 2. Strict contract.
  const issues = jevContractIssues(payload);
  if (issues.length > 0) {
    console.error('FAIL: response does not match the adapter contract:');
    for (const i of issues) console.error(`  - ${i}`);
    return 1;
  }
  console.log('OK   strict contract: answers.task_complexity.probabilities has levels 0/1/2 summing to 1');

  // 3. The production parser on the same payload (same request body JevClassifier sends).
  console.log(`OK   parseJevAnswer: ${fmt(parseJevAnswer(payload))}`);
  if (rawMs > timeoutMs) {
    console.warn(`WARN JEV took ${rawMs} ms > JEV_TIMEOUT_MS=${timeoutMs}: the router would fall back to primary.`);
  }
  return 0;
}

const fmt = (d: { simple: number; standard: number; structural: number }) =>
  `simple=${d.simple.toFixed(3)} standard=${d.standard.toFixed(3)} structural=${d.structural.toFixed(3)}`;

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
