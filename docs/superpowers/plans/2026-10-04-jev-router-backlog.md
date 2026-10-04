# Backlog do jev-router — plano de ataque

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** fechar tudo o que as revisões de 2026-10-04 levantaram (security-review, ponytail-audit, code-review em dois eixos, tech-debt, testing-strategy, graphify): dois bugs de telemetria e erro, lacunas de teste, CI fora da plataforma real, documentação contraditória e quatro decisões de produto.

**Arquitetura:** nenhuma mudança estrutural. Os bugs se corrigem no ponto onde todos os chamadores passam (`AnthropicProvider.send` e o `setErrorHandler` do Fastify). Testes novos seguem o padrão existente: servidores falsos locais, `node:test`, sem rede.

**Stack:** Node ≥ 22.19 (dev em Windows/Node 24), TypeScript, Fastify 5, undici, zod 4, better-sqlite3 12, `node:test` via tsx.

**Ordem:** Fase 1 → 2 → 3 em commits atômicos, cada um com `npm run typecheck` e `npm test` verdes. A Fase 4 são decisões do Bruno; nada nela é executado sem resposta.

---

## Já resolvido (registro)

| Origem | Item | Commit |
|---|---|---|
| security-review | 0 achados com confiança ≥ 8 | — |
| ponytail-audit | drizzle removido; `Config` derivado; 2 knobs mortos removidos | `089f487`, `b6ad7a9` |
| investigação stream_error | retry do Claude Code verificado (2.1.289, não-streaming); teste e2e | `0666f08` |
| testing-strategy P0 | modo `inject`: 401, troca de credencial, `/healthz`, guardas do config | `4cbfae1` |

## Rejeitado de propósito (não executar)

| Achado | Por quê |
|---|---|
| `fromRow` em `src/telemetry/schema.ts` (code-review, smell 4) | Só o teste consumiria: seria código de produção existindo para teste. O mapeamento fica no teste. |
| Tipo de retorno explícito em `loadConfig` (code-review, smell 3) | Recria o tipo escrito à mão que o `b6ad7a9` removeu. O `Readonly` de topo volta na Tarefa 6. |
| `prepare()` por flush no recorder (code-review, smell 6) | Um prepare por segundo; ganho não mensurável. |
| Dividir comunidades de baixa coesão (graphify) | As comunidades seguem os arquivos; coesão baixa aqui é efeito do agrupamento por AST, não acoplamento real. [INFERIDO] |
| Testes da CLI `stats` e da ordem do `.env` (testing-strategy P3) | Código estável e trivial; testar quando mudar. |

---

## Fase 1 — Higiene e documentação (sem decisão pendente, ~1 h)

### Tarefa 1: `.gitignore` cobre artefatos locais

**Arquivos:** Modificar `.gitignore`

- [ ] **Passo 1: acrescentar as três entradas**

```gitignore
graphify-out/
.cursor/
.ai-memory.toml
```

- [ ] **Passo 2: verificar**

Run: `git status -s`
Expected: nenhuma linha `??` para `graphify-out/`, `.cursor/` ou `.ai-memory.toml`.

- [ ] **Passo 3: commit**

```bash
git add .gitignore
git commit -m "chore: ignore graphify output and per-machine agent config"
```

### Tarefa 2: CI na plataforma real (Windows + Node 24)

Motivo: o Bruno desenvolve em Windows/Node 24 e a CI só roda Ubuntu/Node 22, então diferenças de caminho, de tempo e de versão do Node não aparecem. **Isso não teria pego a quebra do `better-sqlite3` v13**: os runners `windows-2022`/`windows-2025` já trazem o Visual Studio 2022 com `Workload.NativeDesktop` [CONFIRMADO no runner-images], e lá a v13 compila. O que protege contra esse caso é a nota no README (Tarefa 3, passo 3).

**Arquivos:** Modificar `.github/workflows/ci.yml` (bloco `jobs.test`)

- [ ] **Passo 1: trocar o cabeçalho do job e o `setup-node`**

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
```

O resto dos `steps` (`npm ci`, `npm run typecheck`, `npm test`) não muda.

- [ ] **Passo 2: commit em branch e abrir PR**

```bash
git switch -c ci/windows-node24
git add .github/workflows/ci.yml
git commit -m "ci: run on windows-latest and Node 24 alongside ubuntu/Node 22"
git push -u origin ci/windows-node24
gh pr create --fill
```

- [ ] **Passo 3: verificar**

Expected: os 4 jobs verdes no PR. Se o Windows falhar em teste com caminho ou tempo, corrigir o teste no mesmo PR; não mesclar com job vermelho.

### Tarefa 3: documentação do `stream_error` com a ressalva do primeiro turno

Motivo: README:374 e `scripts/bench/harness.ts:334-336` dizem sem condição que o retry vai para a Anthropic; o ADR (regra 4) documenta que no primeiro turno ele é reclassificado.

**Arquivos:** Modificar `README.md:374`, `scripts/bench/harness.ts:334-336`

- [ ] **Passo 1: README, linha da tabela do bench**

```markdown
| `stream_error` | Stream broke after it started (e.g. invalid tool JSON): the client gets an `error` event and Claude Code retries; the retry goes to Anthropic, except on a conversation's first turn, where it is re-classified (ADR rule 4) |
```

- [ ] **Passo 2: comentário em `harness.ts`**

```ts
 * - stream_error: the stream broke after it started (e.g. invalid tool JSON).
 *   The router sends an error event; Claude Code retries, and the retry goes
 *   to Anthropic except on a first turn, which is re-classified (ADR rule 4).
```

- [ ] **Passo 3: README, linha do `better-sqlite3` na tabela "Dependencies"**

O `package.json` não aceita comentário. Quem for subir a versão lê esta linha.

```markdown
| `better-sqlite3` | Local SQLite file for the cost audit. One table, plain SQL; migrations are an append-only list applied on boot. **Held at `^12`:** v13 ships no prebuilt binaries and needs a C++ toolchain (MSVC) to install on Windows |
```

- [ ] **Passo 4: commit**

```bash
git add README.md scripts/bench/harness.ts
git commit -m "docs: first-turn stream_error retry is re-classified; why better-sqlite3 stays on v12"
```

### Tarefa 4: tetos nomeados e justificados

**Arquivos:** Modificar `src/serve.ts:25-27`, `src/telemetry/db.ts:25`

- [ ] **Passo 1: `serve.ts`, antes de `export async function serve`**

```ts
// ponytail: fixed cap, one entry per live conversation. An evicted cheap
// conversation is treated as unknown and goes primary: savings lost, never
// correctness. Raise it only if `stats` shows that under heavy parallel use.
const SESSION_MAX_ENTRIES = 10_000;
```

e na construção do router:

```ts
    new TtlLruStore<Route>(SESSION_MAX_ENTRIES, config.router.sessionTtlMs),
```

- [ ] **Passo 2: `db.ts`, trocar o comentário da ponte**

```ts
  // ponytail: drizzle bridge. Databases created under drizzle count their migrations in
  // __drizzle_migrations instead. Delete once every telemetry.db has been opened by this
  // version (it sets user_version, so the bridge never runs twice on the same file).
```

- [ ] **Passo 3: verificar e commitar**

Run: `npm run typecheck && npm test`
Expected: tudo verde.

```bash
git add src/serve.ts src/telemetry/db.ts
git commit -m "refactor: name the session cap and date the drizzle bridge"
```

### Tarefa 5: nomes em `stats.ts`

`window` guarda parâmetros da query; `WHERE` é local em caixa alta.

**Arquivos:** Modificar `src/telemetry/stats.ts`

- [ ] **Passo 1: renomear**

```bash
sed -i 's/const window = /const params = /; s/(window)/(params)/g; s/const WHERE = /const inWindow = /; s/\${WHERE}/${inWindow}/g' src/telemetry/stats.ts
```

- [ ] **Passo 2: verificar**

Run: `grep -nE "window|WHERE" src/telemetry/stats.ts`
Expected: sobram só `WHERE` dentro de strings SQL (`'WHERE (@since IS NULL ...'`) e a palavra "window" em comentários (por exemplo "fall outside the window"). Nenhuma variável `window` nem `WHERE`.

Run: `npm run typecheck && npx tsx --test test/telemetry-stats.test.ts`
Expected: PASS.

- [ ] **Passo 3: commit**

```bash
git add src/telemetry/stats.ts
git commit -m "refactor(telemetry): clearer names for the stats query window"
```

### Tarefa 6: `Config` volta a ser `Readonly` e recupera o comentário perdido

**Arquivos:** Modificar `src/config.ts`

- [ ] **Passo 1: tipo**

```ts
export type Config = Readonly<ReturnType<typeof loadConfig>>;
```

- [ ] **Passo 2: comentário na linha `telemetry:` do objeto retornado**

```ts
    // dbPath is undefined when telemetry is disabled.
    telemetry: { dbPath: e.TELEMETRY_ENABLED ? (e.TELEMETRY_DB_PATH ?? defaultTelemetryDbPath(env)) : undefined },
```

- [ ] **Passo 3: verificar e commitar**

Run: `npm run typecheck && npm test`
Expected: tudo verde.

```bash
git add src/config.ts
git commit -m "refactor(config): keep Config readonly at the top level"
```

### Tarefa 7: avisar no boot quando o `.env` ainda tiver variáveis removidas

Motivo: `ROUTER_ALLOW_ESCALATION` e `SESSION_MAX_ENTRIES` hoje são descartadas pelo zod sem uma palavra. O `.env` do Bruno ainda tem as duas.

**Arquivos:** Modificar `src/config.ts`, `src/serve.ts`; Teste `test/config.test.ts`

- [ ] **Passo 1: teste que falha (em `test/config.test.ts`)**

```ts
import { loadConfig, removedEnvSet } from '../src/config.js';

describe('removedEnvSet', () => {
  it('lists env vars that no longer exist but are still set', () => {
    assert.deepEqual(removedEnvSet({ ROUTER_ALLOW_ESCALATION: 'false', HOST: '127.0.0.1' }), ['ROUTER_ALLOW_ESCALATION']);
    assert.deepEqual(removedEnvSet({}), []);
  });
});
```

(substituir o `import { loadConfig } ...` existente pela linha acima)

- [ ] **Passo 2: ver falhar**

Run: `npx tsx --test test/config.test.ts`
Expected: FAIL, `removedEnvSet` não é exportado.

- [ ] **Passo 3: implementação mínima em `src/config.ts`**

```ts
/** Env vars that were removed: an old .env that still sets them is otherwise ignored without a word. */
const REMOVED_ENV = ['ROUTER_ALLOW_ESCALATION', 'SESSION_MAX_ENTRIES'] as const;

export function removedEnvSet(env: NodeJS.ProcessEnv = process.env): string[] {
  return REMOVED_ENV.filter((name) => env[name] !== undefined);
}
```

e em `src/serve.ts`, logo após o log `'jev-router ready'`:

```ts
  const stale = removedEnvSet();
  if (stale.length > 0) app.log.warn({ stale }, 'ignored: these env vars were removed, delete them from .env');
```

(com `import { removedEnvSet, type Config } from './config.js';`)

- [ ] **Passo 4: ver passar**

Run: `npm run typecheck && npx tsx --test test/config.test.ts`
Expected: PASS.

- [ ] **Passo 5: commit**

```bash
git add src/config.ts src/serve.ts test/config.test.ts
git commit -m "feat(config): warn at boot about removed env vars still set"
```

---

## Fase 2 — Bugs e lacunas de teste (~2 h)

### Tarefa 8: BUG — Anthropic inacessível não gera linha na telemetria

**[CONFIRMADO] em 2026-10-04 por teste com servidor local:** com `ANTHROPIC_UPSTREAM_URL` apontando para uma porta fechada, a resposta é 502 e **0 linhas** são gravadas. Causa: `AnthropicProvider.send` lança a exceção de rede em vez de devolver `unavailable`; o `relay` nunca chama `auditFailure`, e `outcome = 'proxy_error'` nunca acontece. Uma queda da Anthropic some do `stats`.

**Arquivos:** Modificar `src/providers/anthropic.ts:23-31`; Teste `test/proxy.e2e.test.ts` (no `describe` principal, depois de `'records relayed upstream errors as http_error'`)

- [ ] **Passo 1: teste que falha**

```ts
  it('records proxy_error when Anthropic is unreachable', async () => {
    anthropicHandler = (_seen, res) => void res.socket?.destroy();
    const res = await claudeCode('T-down', 'refactor the data layer to clean architecture');
    await res.body.text();
    assert.equal(res.statusCode, 502);
    const [row] = await logsFor('T-down');
    assert.ok(row, 'an Anthropic outage must show up in stats');
    assert.equal(row.outcome, 'proxy_error');
    assert.equal(row.httpStatus, 502);
  });
```

- [ ] **Passo 2: ver falhar**

Run: `npx tsx --test --test-name-pattern="unreachable" test/proxy.e2e.test.ts`
Expected: FAIL em `assert.ok(row, 'an Anthropic outage must show up in stats')`.

- [ ] **Passo 3: correção no ponto comum (`AnthropicProvider.send`), espelhando o `OpenAICompatibleProvider`**

```ts
  async send(req: ProviderRequest): Promise<ProviderResult> {
    let res;
    try {
      res = await request(`${this.options.baseUrl}${req.url}`, {
        method: req.method,
        headers: this.withAuth(req.headers),
        body: req.rawBody ?? null,
        signal: req.signal,
        headersTimeout: this.options.timeoutMs,
        bodyTimeout: this.options.timeoutMs,
      });
    } catch (err) {
      // The client left: nothing to report. Anything else never reached Anthropic.
      if (req.signal.aborted) throw err;
      return { kind: 'unavailable', reason: `network: ${(err as Error).message}` };
    }
    return { kind: 'response', status: res.statusCode, headers: forwardableHeaders(res.headers), body: res.body };
  }
```

Não há failover para o barato aqui: pela regra 5 do ADR, Anthropic → barato só acontece em 429/529 e é opt-in.

- [ ] **Passo 4: ver passar, e a suíte inteira**

Run: `npm run typecheck && npm test`
Expected: tudo verde.

- [ ] **Passo 5: commit**

```bash
git add src/providers/anthropic.ts test/proxy.e2e.test.ts
git commit -m "fix(telemetry): record proxy_error when Anthropic is unreachable"
```

### Tarefa 9: BUG — corpo grande demais vira 502 "upstream unreachable"

**[CONFIRMADO] em 2026-10-04 por teste com servidor local:** com `BODY_LIMIT_BYTES=2000` e corpo de 5 KB, a resposta é 502 `upstream unreachable`. Causa: o `setErrorHandler` converte todo erro em 502, inclusive o 413 que o próprio Fastify gera. O Claude Code lê isso como falha de upstream e tenta de novo, em vez de entender que o pedido é grande demais.

**Arquivos:** Modificar `src/proxy/server.ts` (`setErrorHandler`); Teste `test/proxy.e2e.test.ts` (novo `describe` no fim do arquivo)

Usa um proxy pequeno próprio, como o `describe` do modo `inject`, para não impor um limite minúsculo aos outros testes. Corpo de poucos KB de propósito: com MBs, o servidor pode fechar o socket enquanto o undici ainda envia, e o cliente vê ECONNRESET em vez do 413 (sobretudo no Windows).

- [ ] **Passo 1: teste que falha**

```ts
describe('body limit', () => {
  let upstream: { server: Server; url: string };
  let proxy: FastifyInstance;
  let proxyUrl: string;
  const seen: Seen[] = [];

  before(async () => {
    upstream = await fakeServer(() => anthropicOk, seen);
    const config = loadConfig({
      CLASSIFIER: 'heuristic',
      CHEAP_API_KEY: 'unused',
      ANTHROPIC_UPSTREAM_URL: upstream.url,
      BODY_LIMIT_BYTES: '2000',
      LOG_LEVEL: 'fatal',
    });
    const router = new Router(new HeuristicClassifier(), new TtlLruStore<Route>(100, 60_000), {
      policy: { minCheapProbability: config.router.minCheapProbability, standardRoute: config.router.standardRoute },
      primaryClasses: config.router.primaryClasses,
      cheapContextTokens: 100_000,
      classifierTimeoutMs: 1_000,
      classifierMaxChars: 4_000,
    });
    proxy = buildServer({
      config,
      router,
      providers: { primary: new AnthropicProvider(config.primary), cheap: new OpenAICompatibleProvider(config.cheap) },
    });
    await proxy.listen({ host: '127.0.0.1', port: 0 });
    proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await proxy.close();
    upstream.server.close();
  });

  it('answers an oversized body with 413, not an upstream error', async () => {
    const res = await request(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x'.repeat(5_000) }] }),
    });
    const body = (await res.body.json()) as { error: { type: string } };
    assert.equal(res.statusCode, 413);
    assert.equal(body.error.type, 'request_too_large');
    assert.equal(seen.length, 0, 'nothing reaches Anthropic');
  });
});
```

- [ ] **Passo 2: ver falhar**

Run: `npx tsx --test --test-name-pattern="oversized" test/proxy.e2e.test.ts`
Expected: FAIL, `502 !== 413`.

- [ ] **Passo 3: correção**

```ts
  app.setErrorHandler((err, req, reply) => {
    if (reply.raw.destroyed) return; // client went away mid-request
    // Fastify's own 4xx (body too large, bad content type) are the client's problem, not the upstream's.
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send(anthropicError(status === 413 ? 'request_too_large' : 'invalid_request_error', err.message));
    }
    req.log.error({ err }, 'request failed');
    return reply.code(502).send(anthropicError('api_error', 'jev-router: upstream unreachable'));
  });
```

`request_too_large` é o tipo que a própria Anthropic usa para 413.

- [ ] **Passo 4: ver passar, de forma estável, e commitar**

Run: `for i in 1 2 3 4 5; do npx tsx --test --test-name-pattern="oversized" test/proxy.e2e.test.ts 2>&1 | grep -E "ℹ (pass|fail)"; done`
Expected: 5 × `pass 1` / `fail 0`.

Run: `npm run typecheck && npm test`
Expected: tudo verde.

```bash
git add src/proxy/server.ts test/proxy.e2e.test.ts
git commit -m "fix(proxy): relay Fastify 4xx such as 413 instead of calling them upstream failures"
```

### Tarefa 10: testes do proxy fiéis ao Claude Code real

Cobre: parâmetro `text` morto no helper; retry testado com `stream: true` quando o Claude Code real repete sem streaming; teste do 503 que promete "pins the conversation" sem verificar; e o comportamento do primeiro turno, que hoje não tem teste e pode mudar sem ninguém ver.

**Arquivos:** Modificar `test/proxy.e2e.test.ts`

- [ ] **Passo 1: handler JSON e helper de turno com ferramenta (no topo do arquivo, ao lado dos outros handlers)**

```ts
/** Non-streaming chat completion: what the cheap provider returns when Claude Code retries without a stream. */
const openAiJson: Handler = (_seen, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 5 } }));
};

/** A tool-result continuation: not a fresh conversation, so the router reuses the sticky route. */
const toolLoop = (text: string) => [
  { role: 'user', content: [{ type: 'text', text }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/r/README.md' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Teh readme' }] },
];
```

- [ ] **Passo 2: novo helper `claudeCode` (substitui o atual)**

```ts
  const claudeCode = (sessionId: string, turn: string | object[], { stream = true } = {}) =>
    request(`${proxyUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-client',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'some-future-beta',
        'x-claude-code-session-id': sessionId,
        'x-claude-code-request-class': 'main',
      },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 64_000,
        stream,
        system: [{ type: 'text', text: 'You are Claude Code' }],
        messages: typeof turn === 'string' ? [{ role: 'user', content: [{ type: 'text', text: turn }] }] : turn,
      }),
    });
```

- [ ] **Passo 3: teste do corte no meio usa o helper novo e repete sem streaming**

```ts
  it('ends a stream cut mid-way with an error event and sends Claude Code’s retry to Anthropic', async () => {
    await (await claudeCode('S-cut', 'fix the typo')).body.text();

    cheapHandler = openAiCutMidStream;
    const broken = await claudeCode('S-cut', toolLoop('fix the typo'));
    const text = await broken.body.text();
    assert.equal(broken.headers['x-jev-route'], 'cheap; reason=sticky');
    assert.match(text, /event: error\ndata: \{"type":"error","error":\{"type":"api_error"/);

    // Claude Code 2.1.289 re-sends the same turn as a non-streaming request.
    const retry = await claudeCode('S-cut', toolLoop('fix the typo'), { stream: false });
    await retry.body.text();
    assert.equal(retry.headers['x-jev-route'], 'primary; reason=sticky');
    assert.equal(cheapLog.length, 2, 'the cheap provider is not tried again');
    assert.equal(anthropicLog.length, 1);
  });
```

- [ ] **Passo 4: o teste do 503 passa a verificar a fixação que o título promete**

```ts
  it('fails over to Anthropic when the cheap provider is down, and pins the conversation', async () => {
    cheapHandler = openAi503;
    const res = await claudeCode('S-down', 'fix the typo');
    await res.body.text();
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-jev-route'], 'primary; reason=failover:cheap-unavailable');

    const next = await claudeCode('S-down', toolLoop('fix the typo'));
    await next.body.text();
    assert.equal(next.headers['x-jev-route'], 'primary; reason=sticky');
    assert.equal(cheapLog.length, 1, 'the cheap provider is not tried again');
    assert.equal(anthropicLog.length, 2);
  });
```

- [ ] **Passo 5: teste de caracterização do primeiro turno (registra o comportamento atual; muda junto com a Decisão D2)**

```ts
  it('re-classifies the retry of a first turn cut mid-stream (ADR rule 4: the pin does not hold)', async () => {
    cheapHandler = openAiCutMidStream;
    await (await claudeCode('S-cut-first', 'fix the typo')).body.text();

    cheapHandler = openAiJson;
    const retry = await claudeCode('S-cut-first', 'fix the typo', { stream: false });
    await retry.body.text();
    assert.equal(retry.headers['x-jev-route'], 'cheap; reason=classified');
  });
```

- [ ] **Passo 6: verificar que os testes pegam regressão**

Run: `npm test`
Expected: tudo verde.

Depois, quebrar de propósito e restaurar:

```bash
sed -i "s/    if (decision.conversationKey) this.sessions.set(decision.conversationKey, 'primary');/    return;/" src/routing/router.ts
npx tsx --test test/proxy.e2e.test.ts 2>&1 | grep "✖"
git checkout -- src/routing/router.ts
```

Expected: falham `ends a stream cut mid-way...` e `fails over ... and pins the conversation`.

- [ ] **Passo 7: commit**

```bash
git add test/proxy.e2e.test.ts
git commit -m "test(proxy): non-streaming retry, pin after failover, first-turn behaviour"
```

### Tarefa 11: `client_abort` registrado na telemetria

**Arquivos:** Teste `test/proxy.e2e.test.ts` (depois da Tarefa 8)

- [ ] **Passo 1: teste**

```ts
  it('records client_abort when Claude Code hangs up mid-stream', async () => {
    anthropicHandler = async (_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
      await sleep(500);
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    };
    const res = await claudeCode('T-abort', 'refactor the data layer to clean architecture');
    for await (const _chunk of res.body) {
      res.body.destroy();
      break;
    }
    const [row] = await logsFor('T-abort');
    assert.ok(row);
    assert.equal(row.outcome, 'client_abort');
  });
```

- [ ] **Passo 2: verificar que pega regressão**

Run: `npx tsx --test --test-name-pattern="client_abort" test/proxy.e2e.test.ts`
Expected: PASS. Depois trocar em `src/telemetry/audit.ts` `? 'client_abort'` por `? 'ok'`, rodar de novo e ver FAIL, e restaurar com `git checkout -- src/telemetry/audit.ts`.

Se o teste passar só às vezes, o `logsFor` (20 × 10 ms) está curto para o `close` do socket: aumentar para `for (let i = 0; i < 100; i++)` dentro de `logsFor`.

- [ ] **Passo 3: commit**

```bash
git add test/proxy.e2e.test.ts
git commit -m "test(telemetry): client hang-up is recorded as client_abort"
```

### Tarefa 12: `TtlLruStore` com teste próprio

**Arquivos:** Criar `test/session-store.test.ts`

- [ ] **Passo 1: testes**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TtlLruStore } from '../src/routing/session-store.js';

describe('TtlLruStore', () => {
  it('forgets an entry once its TTL has passed', () => {
    let now = 0;
    const store = new TtlLruStore<string>(10, 1_000, () => now);
    store.set('a', 'cheap');
    now = 999;
    assert.equal(store.get('a'), 'cheap');
    now = 2_000;
    assert.equal(store.get('a'), undefined);
  });

  it('evicts the least recently used entry beyond capacity', () => {
    const store = new TtlLruStore<string>(2, 60_000);
    store.set('a', '1');
    store.set('b', '2');
    store.get('a'); // a becomes the most recent
    store.set('c', '3'); // evicts b
    assert.equal(store.get('b'), undefined);
    assert.equal(store.get('a'), '1');
    assert.equal(store.get('c'), '3');
  });
});
```

- [ ] **Passo 2: verificar que pega regressão**

Run: `npx tsx --test test/session-store.test.ts`
Expected: PASS. Depois remover a linha `this.entries.set(key, entry);` do `get` em `src/routing/session-store.ts`, ver o segundo teste falhar, e restaurar com `git checkout -- src/routing/session-store.ts`.

- [ ] **Passo 3: commit**

```bash
git add test/session-store.test.ts
git commit -m "test(routing): TTL expiry and LRU eviction of the session store"
```

---

## Fase 3 — Medição (precisa de Ollama e do Claude Code; ~1 h)

### Tarefa 13: histórico do bench no README

**Arquivos:** Modificar `README.md`, seção "Checks against real APIs", logo após o bloco do `bench.ts`

- [ ] **Passo 1: acrescentar**

```markdown
### Bench history

Run `npx tsx scripts/bench.ts --trials 5 --pad-kb 32` before changing `CHEAP_MODEL`, and add a row.

| Date | Model | Trials | Success | Provider failures | Avg trial | Notes |
|---|---|---|---|---|---|---|
| 2026-10-04 | `gpt-oss:20b-cloud` | 15 (pad 32 KB, 12 steps) | 93% | 7% (1 `stream_error`) | 6.7 s | 25 schema errors, mostly `Read` with `offset: 0`. A separate 45-trial capture: 0 `stream_error`, 1 `rename` `wrong_result` (import not updated). |
```

- [ ] **Passo 2: commit**

```bash
git add README.md
git commit -m "docs(bench): record the first gpt-oss:20b-cloud baseline"
```

### Tarefa 14: o `Read` real do Claude Code aceita `offset: 0`?

Decide se os 25 erros de schema do bench são do modelo ou só do bench.

**Arquivos:** Criar `scripts/probe-read-offset.mjs` (descartável; não commitar)

- [ ] **Passo 1: servidor falso que pede `Read` com `offset: 0`**

```js
// Fake Anthropic: asks Claude Code for Read {offset: 0} and prints the tool_result it gets back.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const file = process.argv[2];
writeFileSync(file, 'line one\nline two\n');
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });

createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) return void res.writeHead(404).end('{}');
  const parsed = JSON.parse(body);
  if (!parsed.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  const last = parsed.messages.at(-1);
  const result = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : undefined;
  if (result) console.log('TOOL_RESULT', JSON.stringify(result).slice(0, 400));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(start);
  if (!result) {
    res.write(ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }));
    res.write(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: file, offset: 0, limit: 200 }) } }));
    res.write(ev('content_block_stop', { index: 0 }));
    res.write(ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }));
  } else {
    res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } }));
    res.write(ev('content_block_stop', { index: 0 }));
    res.write(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
  }
  res.end(ev('message_stop', {}));
}).listen(18560, '127.0.0.1', () => console.log('fake anthropic on 18560'));
```

- [ ] **Passo 2: rodar contra o Claude Code real**

```bash
node scripts/probe-read-offset.mjs "$TEMP/probe-read.txt" &
ANTHROPIC_BASE_URL=http://127.0.0.1:18560 ANTHROPIC_API_KEY=local-test-key claude -p "read the file" --model claude-haiku-4-5 < /dev/null
```

Expected: uma linha `TOOL_RESULT`.

- [ ] **Passo 3: decidir pela saída**

- `TOOL_RESULT` com o conteúdo do arquivo: o Claude Code aceita `offset: 0`. Em `scripts/bench/harness.ts`, trocar `offset: z.number().int().min(1).optional()` por `offset: z.number().int().min(0).optional()`, ajustar `readFile` para `const start = Math.max((offset ?? 1) - 1, 0);`, rodar `npm test` e commitar `fix(bench): accept Read offset 0 like Claude Code does`.
- `TOOL_RESULT` com `InputValidationError`: o bench está certo. Acrescentar à linha do bench no README (Tarefa 13): "Read offset:0 rejected by Claude Code too: one wasted turn per first read". Sem mudança de código.

- [ ] **Passo 4: apagar o script e matar o servidor**

```bash
rm scripts/probe-read-offset.mjs
```

### Tarefa 15: medir cobertura

**Arquivos:** Modificar `package.json` (scripts)

- [ ] **Passo 1: script**

```json
    "coverage": "node --import tsx --test --experimental-test-coverage test/*.test.ts",
```

- [ ] **Passo 2: rodar e registrar**

Run: `npm run coverage`
Expected: tabela por arquivo. Meta: 100% dos ramos em `src/proxy/server.ts`, `src/providers/anthropic.ts`, `src/config.ts` e `src/telemetry/cost.ts`; cerca de 80% de linhas no total. Anotar os números na mensagem do commit.

- [ ] **Passo 3: commit**

```bash
git add package.json
git commit -m "chore: npm run coverage via node's built-in test coverage"
```

---

## Fase 4 — Decisões do Bruno (nada aqui roda sem resposta)

### D1: perda silenciosa de qualidade no barato (maior risco real)

Fato: `rename` termina errado em cerca de 1 de 10 tentativas, com o modelo dizendo que acabou. O roteador não detecta.

| Opção | Custo | Efeito |
|---|---|---|
| A. Subir `ROUTER_MIN_CHEAP_PROBABILITY` para 0.9 | 1 linha no `.env` | Menos tarefas no barato; as que vão são mais simples. |
| B. Trocar de modelo comparando pelo bench (Tarefa 13) | 1 rodada de bench por candidato | Depende do modelo. |
| C. Verificar o resultado depois do modelo barato | Alto; contraria o desenho (o roteador não executa nada) | Pega o erro, mas transforma o proxy em agente. |

**Recomendação:** A agora, mas sem prometer efeito. Hoje há 0 linhas com veredito do JEV na telemetria, e a única resposta real vista foi `simple=1.000`, então não se sabe quantas tarefas ficam entre 0,8 e 0,9 [INFERIDO]. Medir por uma semana com a consulta abaixo. O `stats` não serve: o `Repeated prompts` dele é global, não separado por provedor.

```sql
-- Prompts repeated after an answer, by the provider that served the first send.
WITH firsts AS (
  SELECT human_prompt_hash, final_provider,
         count(*) OVER (PARTITION BY human_prompt_hash) AS sends,
         row_number() OVER (PARTITION BY human_prompt_hash ORDER BY id) AS nth
  FROM router_logs WHERE human_prompt_hash IS NOT NULL
)
SELECT final_provider, count(*) AS prompts, sum(sends > 1) AS repeated,
       round(100.0 * sum(sends > 1) / count(*), 1) AS repeated_pct
FROM firsts WHERE nth = 1 GROUP BY final_provider;
```

Rodar com `sqlite3 ~/.jev-router/telemetry.db` ou com o `better-sqlite3` em modo leitura. Se `repeated_pct` no `openai` ficar bem acima do `anthropic`, vá para B.

### D2: fixação na Anthropic no primeiro turno

Fato: se o corte acontece no primeiro turno, a nova tentativa é reclassificada e pode voltar ao barato. O impacto é baixo, porque essa nova tentativa vem sem streaming e qualquer falha de tradução cai na Anthropic antes do primeiro byte [INFERIDO pelo código; o teste da Tarefa 10 fixa o comportamento atual].

| Opção | Custo |
|---|---|
| A. Manter (documentado no ADR) | 0 |
| B. `pinToPrimary` também grava a fixação pela impressão digital da primeira mensagem, e conversas novas consultam essa chave | ~10 linhas no `router.ts`; precisa distinguir "nova tentativa" de "conversa nova depois de `/clear`" na mesma sessão |

**Recomendação:** A, até a telemetria mostrar `stream_error` em primeiro turno com frequência.

### D3: `better-sqlite3` (nativo) contra `node:sqlite`

Fato: o `better-sqlite3` está fixado na v12 porque a v13 exige compilador C++ no Windows. Sem o drizzle, trocar para o `node:sqlite` do próprio Node é viável (está disponível no Node 24 desta máquina) e elimina a dependência nativa. O custo é que no Node 22 ele ainda é marcado como experimental [PROVÁVEL].

**Recomendação:** manter a v12 fixada. A CI no Windows **não** avisaria (os runners têm MSVC e compilam a v13); quem protege é a nota no README (Tarefa 3, passo 3). Reabrir quando o `engines` for para Node ≥ 24.

---

## Autorrevisão (feita)

- **Cobertura das fontes:**
  - security-review (nada a fazer).
  - ponytail-audit (aplicado).
  - code-review Padrões: smells 1 e 8 → T4; 2 → T7; 3 → T6 e rejeitado; 4 → rejeitado; 5 → T5; 6 → rejeitado; 7 → T10.
  - code-review Especificação: 1 → T3; 2 → T10; 3 → T10 passo 6; 4 → T4.
  - tech-debt: 1 → T2 (motivo corrigido: não pegaria a v13) e T3 passo 3; 2 → T3; 3 → T13; 4 → rejeitado; 5 → T10; 6 → D3; 7 → D1; 8 → D2 e T10; 9 → T14; 10 → T4 e T6; 11 → T1; 12 → T7.
  - testing-strategy: P0 feito; P1 → T8, T9, T11 e T2; P2 → T10 e T12; P3 rejeitado; cobertura → T15.
  - graphify: `.gitignore` → T1; coesão → rejeitado.
  - Bugs novos: T8 e T9.
- **Sem placeholders:** todo passo de código traz o código.
- **Consistência:**
  - `claudeCode(sessionId, turn, { stream })`, `toolLoop(text)` e `openAiJson` são definidos na T10 e só usados depois dela.
  - T11 depende de `logsFor` (já existe) e vem depois da T8.
  - `removedEnvSet` é definido e testado na T7.
