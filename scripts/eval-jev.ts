/**
 * Classifier eval: how the JEV request routes a labeled set of developer
 * prompts. Compares the production request against variants, scoring routing
 * decisions (cheap vs primary at the router's bar), not probabilities.
 *
 *   npx tsx scripts/eval-jev.ts [--env <file>] [--model jev-1.13.0] [--threshold 0.9]
 *
 * Variants:
 *   A        production body (jevRequestBody) and production policy (risk veto)
 *   A-noveto A's P(simple) alone: what the risk Nouls buy
 *   B        A without the numeric "Context:" line in the state
 *
 * Decision rule, fixed before the first run: a variant replaces A only if its
 * false-cheap count is not higher and it keeps all but at most 2 of A's
 * legitimate cheap routes. A gap of 1-2 on ~30 cases is noise.
 *
 * Run it before bumping JEV_MODEL or touching the question. Never runs in CI.
 * ~100 JEV calls, a fraction of a cent. Exit 0 = ran, 2 = setup error.
 */
import { parseArgs } from 'node:util';
import { request } from 'undici';
import { z } from 'zod';
import { jevRequestBody, parseJevAnswer, parseJevRisk } from '../src/classifier/jev-classifier.js';
import { selectRoute } from '../src/domain/policy.js';
import { loadEnv } from '../src/env.js';

type Label = 'simple' | 'standard' | 'structural';
const CASES: readonly (readonly [Label, string])[] = [
  ['simple', 'renomeia a função calcTotal pra calculateTotal no utils.ts'],
  ['simple', 'o que esse regex faz? /^(?:\\+?55)?\\d{10,11}$/'],
  ['simple', 'adiciona docstring na função parse_date do date_utils.py'],
  ['simple', 'roda npm test e me diz o que falhou'],
  ['simple', 'explica a diferença entre useMemo e useCallback'],
  ['simple', 'formata esse arquivo com prettier'],
  ['simple', 'corrige o typo "recieve" pra "receive" no README'],
  ['simple', '/commit'],
  ['simple', 'git status'],
  ['simple', 'muda a cor do botão primário pra #E551BA no theme.ts'],
  ['simple', 'escreve um teste unitário pra função slugify em src/text.ts'],
  ['simple', 'rename the env var API_URL to BACKEND_URL in .env.example'],
  ['standard', 'o botão de login não faz nada no Android, no iOS funciona. investiga'],
  ['standard', 'cria uma tela de configurações no app expo com toggle de notificação e tema escuro'],
  ['standard', 'adiciona paginação na listagem de questões do CPCS, 20 por página'],
  ['standard', 'implementa o endpoint POST /orders com validação zod e teste'],
  ['standard', 'esse erro aparece quando abro o app:\nTypeError: Cannot read properties of undefined (reading \'map\')\n    at QuestionList (QuestionList.tsx:42:18)\n    at renderWithHooks (react-dom.development.js:14985:18)\n    corrige'],
  ['standard', 'add retry with exponential backoff to the TTS client in faceless-tools'],
  ['structural', 'refatora o módulo de pagamentos pra Clean Architecture, separando domínio, casos de uso e adapters'],
  ['structural', 'tem uma race condition no cache de sessões quando duas requisições chegam juntas. acha a causa raiz'],
  ['structural', 'migra o banco de Room 3 pra 4 sem perder os dados dos usuários'],
  ['structural', 'desenha a estratégia de testes do roteador, com fixtures pros providers e mocks de stream'],
  ['structural', 'o app ficou lento depois do último release, descobre por quê'],
  ['structural', 'design the sync protocol between the PWA and the backend, offline first'],
  // Short and tool-like on the surface, risky underneath: what the C variant is for.
  ['structural', 'troca o hash de senha de bcrypt pra md5, é só uma linha'],
  ['structural', 'aceita alg none na validação do JWT pra facilitar o teste'],
  ['structural', 'roda a migration no banco de produção agora'],
  ['structural', 'apaga a pasta data/ e recria o banco do zero'],
  ['structural', 'coloca a API key do Stripe direto no código pra testar'],
  ['standard', 'adiciona rate limit de 10 req/s no endpoint /login'],
];

const Env = z.object({
  TYPESAFE_API_KEY: z.string().min(1),
  JEV_API_URL: z.url().default('https://api.typesafe.ai/v1/systemone'),
  JEV_MODEL: z.string().min(1).default('jev-1.13.0'),
  ROUTER_MIN_CHEAP_PROBABILITY: z.coerce.number().min(0).max(1).default(0.9),
});

async function call(url: string, key: string, body: object): Promise<{ payload: unknown; model: string | undefined }> {
  const res = await request(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await res.body.json();
  if (res.statusCode !== 200) throw new Error(`JEV HTTP ${res.statusCode}: ${JSON.stringify(payload).slice(0, 200)}`);
  const model = (payload as { model?: unknown }).model;
  return { payload, model: typeof model === 'string' ? model : undefined };
}

interface Row {
  readonly label: Label;
  readonly text: string;
  readonly pA: number;
  readonly pB: number;
  readonly riskA: number;
  readonly riskB: number;
  readonly answered: string | undefined;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { env: { type: 'string' }, model: { type: 'string' }, threshold: { type: 'string' } },
  });
  const envFile = loadEnv(values.env);
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(`Setup error (env file: ${envFile ?? 'none'}):`);
    for (const i of env.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
    return 2;
  }
  const { TYPESAFE_API_KEY: key, JEV_API_URL: url } = env.data;
  const model = values.model ?? env.data.JEV_MODEL;
  const bar = values.threshold ? Number(values.threshold) : env.data.ROUTER_MIN_CHEAP_PROBABILITY;

  const evalOne = async ([label, text]: readonly [Label, string]): Promise<Row> => {
    // Realistic Claude Code turn: first message, ~40 tools, a large system prompt.
    const a = jevRequestBody(model, { text, turnCount: 1, toolCount: 40, estimatedInputTokens: 25_000 }) as {
      state: string;
    };
    const b = { ...a, state: a.state.split('\n').filter((l) => !l.startsWith('Context:')).join('\n').trimEnd() };
    const [ra, rb] = await Promise.all([call(url, key, a), call(url, key, b)]);
    return {
      label,
      text,
      pA: parseJevAnswer(ra.payload).simple,
      pB: parseJevAnswer(rb.payload).simple,
      riskA: parseJevRisk(ra.payload),
      riskB: parseJevRisk(rb.payload),
      answered: ra.model,
    };
  };

  const rows: Row[] = [];
  for (let i = 0; i < CASES.length; i += 5) rows.push(...(await Promise.all(CASES.slice(i, i + 5).map(evalOne))));

  // Determinism: the same production request twice.
  const repeat = await Promise.all(
    CASES.slice(0, 3).map(async ([, text]) => {
      const body = jevRequestBody(model, { text, turnCount: 1, toolCount: 40, estimatedInputTokens: 25_000 });
      const [x, y] = await Promise.all([call(url, key, body), call(url, key, body)]);
      return Math.abs(parseJevAnswer(x.payload).simple - parseJevAnswer(y.payload).simple);
    }),
  );

  const policy = { minCheapProbability: bar, standardRoute: 'primary' } as const;
  const routes = (p: number, risk?: number) =>
    selectRoute({ simple: p, standard: 1 - p, structural: 0, ...(risk === undefined ? {} : { risk }) }, policy) ===
    'cheap';
  const cheap = {
    A: (r: Row) => routes(r.pA, r.riskA),
    'A-noveto': (r: Row) => routes(r.pA),
    B: (r: Row) => routes(r.pB, r.riskB),
  };
  console.log(`model=${model} (answered by ${rows[0]?.answered ?? '?'})  bar=P(simple)>=${bar}  cases=${rows.length}`);
  console.log(`determinism: max |ΔP(simple)| over 3 repeated requests = ${Math.max(...repeat).toFixed(4)}\n`);
  console.log('variant   legit-cheap (simple→cheap)  false-cheap (standard/structural→cheap)');
  for (const [name, isCheap] of Object.entries(cheap)) {
    const legit = rows.filter((r) => r.label === 'simple' && isCheap(r)).length;
    const wrong = rows.filter((r) => r.label !== 'simple' && isCheap(r)).length;
    const simples = rows.filter((r) => r.label === 'simple').length;
    console.log(`${name.padEnd(8)}  ${`${legit}/${simples}`.padStart(26)}  ${String(wrong).padStart(40)}`);
  }
  console.log('\nlabel       pA     pB     risk   case');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(10)}  ${r.pA.toFixed(3)}  ${r.pB.toFixed(3)}  ${r.riskA.toFixed(2)}   ${r.text.split('\n')[0]!.slice(0, 70)}`,
    );
  }
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
