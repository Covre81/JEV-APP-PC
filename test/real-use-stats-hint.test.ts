import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { loadConfig } from '../src/config.js';
import type { Tier } from '../src/domain/policy.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai/provider.js';
import { buildServer } from '../src/proxy/server.js';
import { Router } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';
import { openTelemetryDb, type TelemetryDb } from '../src/telemetry/db.js';
import { SqliteTelemetry } from '../src/telemetry/recorder.js';
import { computeCacheMisses, computeStats, renderStats } from '../src/telemetry/stats.js';
import { pricingFromEnv } from '../src/telemetry/pricing.js';
import { meterAnthropicBody } from '../src/telemetry/usage-meter.js';
import { isAcknowledgement } from '../src/telemetry/audit.js';
import { needsReadFirstHint, withReadFirstHint } from '../src/routing/read-first-hint.js';
import { MessagesBody } from '../src/routing/messages-body.js';
import { Readable } from 'node:stream';
import type { ClassificationInput, ComplexityClassifier } from '../src/classifier/classifier.js';
import type { ComplexityDistribution } from '../src/domain/complexity.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
}

type Handler = (seen: Seen, res: ServerResponse) => Promise<void> | void;

async function fakeServer(handler: () => Handler, log: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const raw = Buffer.concat(parts).toString('utf8');
    const seen = { method: req.method!, url: req.url!, headers: req.headers, raw, body: raw ? JSON.parse(raw) : undefined };
    log.push(seen);
    await handler()(seen, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const anthropicOk: Handler = async (seen, res) => {
  if (seen.method === 'HEAD') return void res.writeHead(200).end();
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `event: message_start\ndata: {"type":"message_start","message":{"model":"${seen.body?.model ?? 'claude-opus-5'}","usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}\n\n`,
  );
  await sleep(10);
  res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n`);
  res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
};

const openAiStream: Handler = async (_seen, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
  await sleep(10);
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.write('data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\n');
  res.end('data: [DONE]\n\n');
};

const openAi503: Handler = (_seen, res) => {
  res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"message":"over capacity"}}');
};

const SIMPLE: ComplexityDistribution = { simple: 0.92, standard: 0.06, structural: 0.02 };

class ScriptedClassifier implements ComplexityClassifier {
  readonly name = 'scripted';
  calls: ClassificationInput[] = [];
  constructor(private readonly next: () => ComplexityDistribution | Error) {}
  classify(input: ClassificationInput): Promise<ComplexityDistribution> {
    this.calls.push(input);
    const r = this.next();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

describe('Stats and Hint improvements', () => {
  it('1) cache-miss causes', () => {
    const db = openTelemetryDb(':memory:');
    const pricing = pricingFromEnv({});
    
    db.exec(`
      INSERT INTO router_logs (final_provider, route_reason, max_tokens, tokens_in, cache_write_tokens, created_at, session_id, request_class, requested_model, system_hash, outcome, latency_ms) VALUES 
      ('anthropic', 'reason', 100, 200000, 200000, 1000000, 's1', 'main', 'claude-sonnet-5', 'sys1', 'ok', 100), -- 1: first Anthropic main row -> first-turn-of-session
      ('openai', 'reason', 100, 200000, 0, 1001000, 's1', 'main', 'claude-sonnet-5', 'sys1', 'ok', 100), -- cheap main row
      ('anthropic', 'reason', 100, 200000, 200000, 1002000, 's1', 'main', 'claude-sonnet-5', 'sys1', 'ok', 100), -- 2: after cheap main -> return-from-cheap
      ('anthropic', 'failover:cheap-unavailable', 100, 200000, 200000, 1003000, 's1', 'main', 'claude-sonnet-5', 'sys1', 'ok', 100), -- 3: failover -> failover-from-cheap
      ('anthropic', 'reason', 100, 200000, 200000, 1004000, 's1', 'auxiliary', 'claude-opus-5-5', 'sys1', 'ok', 100), -- 4: first auxiliary
      ('anthropic', 'reason', 100, 200000, 200000, 1005000, 's1', 'auxiliary', 'claude-sonnet-5', 'sys1', 'ok', 100), -- 5: auxiliary model-switch -> model-switch
      ('anthropic', 'reason', 1, 200000, 200000, 1006000, 's2', 'main', 'claude-sonnet-5', 'sys1', 'ok', 100), -- probe row, ignored
      ('anthropic', 'reason', 100, 200000, 200000, 1007000, 's3', 'auxiliary', 'claude-opus-5-5', 'sys1', 'ok', 100), -- title call
      ('anthropic', 'reason', 100, 200000, 200000, 1008000, 's3', 'main', 'claude-sonnet-5', 'sys2', 'ok', 100), -- 6: main row after auxiliary -> first-turn-of-session (not system-changed)
      ('anthropic', 'reason', 100, 200000, 200000, 1009000, 's3', 'main', 'claude-sonnet-5', 'sys3', 'ok', 100) -- 7: system-changed
    `);

    const stats = computeCacheMisses(db, pricing, { minWrite: 150000 });
    const causes = stats.misses.map((m: any) => m.cause);
    
    assert.deepEqual(causes, [
      'first-turn-of-session', 
      'return-from-cheap',
      'failover-from-cheap',
      'first-turn-of-session',
      'model-switch',
      'first-turn-of-session',
      'first-turn-of-session',
      'system-changed'
    ]);
    db.close();
  });

  it('isAcknowledgement rules', () => {
    assert.equal(isAcknowledgement('ok'), true);
    assert.equal(isAcknowledgement('obrigado!'), true);
    assert.equal(isAcknowledgement('ficou top'), true);
    assert.equal(isAcknowledgement('valeu, ficou top'), true);
    assert.equal(isAcknowledgement('Olha, as mudancas que fiz com o grok bot ficaram top'), true);
    assert.equal(isAcknowledgement('show!'), true);
    assert.equal(isAcknowledgement('ok, now fix the bug in src/a.ts'), false);
    assert.equal(isAcknowledgement('what next?'), false);
    assert.equal(isAcknowledgement('show me the status of the build'), false);
    assert.equal(isAcknowledgement('stop the server'), false);
    assert.equal(isAcknowledgement('token count looks ok but read README.md'), false);
    assert.equal(isAcknowledgement('book'), false);
  });

  it('3) endsWithQuestion', async () => {
    const collect = async (r: Readable) => Buffer.concat(await r.toArray());
    
    // JSON body ending with ?
    const jsonBody = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'what next?' }] }));
    const mJson = meterAnthropicBody(Readable.from([jsonBody]), 'application/json', undefined);
    await collect(mJson.body);
    await mJson.settled;
    assert.equal(mJson.endsWithQuestion(), true);

    // JSON body ending with period
    const jsonBody2 = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'done.' }] }));
    const mJson2 = meterAnthropicBody(Readable.from([jsonBody2]), 'application/json', undefined);
    await collect(mJson2.body);
    await mJson2.settled;
    assert.equal(mJson2.endsWithQuestion(), false);

    // SSE body ending with ?
    const sse = Buffer.from(
      [
        'event: message_start',
        'data: {"type":"message_start"}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"what "}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"next?"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\r\n'),
    );
    const mSse = meterAnthropicBody(Readable.from([sse]), 'text/event-stream', undefined);
    await collect(mSse.body);
    await mSse.settled;
    assert.equal(mSse.endsWithQuestion(), true);
  });

  it('4) quota labels', () => {
    const db = openTelemetryDb(':memory:');
    const pricing = pricingFromEnv({});
    
    db.exec(`
      INSERT INTO router_logs (final_provider, outcome, route_reason, max_tokens, http_status, created_at, latency_ms) VALUES 
      ('anthropic', 'ok', 'failover:primary-rate-limited', 1, 429, 1000, 10),
      ('anthropic', 'ok', 'failover:primary-rate-limited', 64000, 429, 2000, 10),
      ('anthropic', 'ok', 'reason', 1, 529, 3000, 10)
    `);

    const stats = computeStats(db, { pricing });
    assert.equal(stats.quotaRouted, 1); // only the max_tokens 64000 one
    assert.equal(stats.probeRateLimited, 2); // the two max_tokens=1 probes
    
    const rendered = renderStats(stats);
    assert.ok(rendered.includes('Rate-limited session probes'));
    
    db.close();
  });

  it('5) needsReadFirstHint and withReadFirstHint', () => {
    const freshBody = (text: string, tools: boolean = true) => MessagesBody.parse({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      tools: tools ? [{ name: 'Read', input_schema: { type: 'object', properties: {} } }] : undefined
    });

    const secondTurnBody = MessagesBody.parse({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'o que falta fazer?' }] }
      ],
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
    });

    const continuationBody = MessagesBody.parse({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
      ],
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
    });

    assert.equal(needsReadFirstHint(freshBody('estou pensando no que fazer')), true);
    assert.equal(needsReadFirstHint(freshBody('o que falta fazer?')), true);
    assert.equal(needsReadFirstHint(freshBody('What should we do next?')), true);
    assert.equal(needsReadFirstHint(freshBody('Onde paramos?')), true);
    assert.equal(needsReadFirstHint(freshBody('fix the typo in the README')), false);
    assert.equal(needsReadFirstHint(freshBody('explain this function')), false);
    assert.equal(needsReadFirstHint(freshBody('corrija todos os testes')), false);
    assert.equal(needsReadFirstHint(freshBody('the planet')), false);
    assert.equal(needsReadFirstHint(freshBody('estou penso emo que fazer.')), true);
    
    assert.equal(needsReadFirstHint(secondTurnBody), false);
    assert.equal(needsReadFirstHint(freshBody('Onde paramos?', false)), false); // no file tools
    assert.equal(needsReadFirstHint(continuationBody), false);

    const bStringSystem = MessagesBody.parse({ model: 'x', messages: [{ role: 'user', content: 'hi' }], system: 'A' });
    const cString = structuredClone(bStringSystem);
    const resultString = withReadFirstHint(bStringSystem);
    assert.deepEqual(bStringSystem, cString);
    assert.ok(typeof resultString.system === 'string' && resultString.system.includes('Before answering'));
    
    const bArraySystem = MessagesBody.parse({ model: 'x', messages: [{ role: 'user', content: 'hi' }], system: [{ type: 'text', text: 'A' }] });
    const cArray = structuredClone(bArraySystem);
    const resultArray = withReadFirstHint(bArraySystem);
    assert.deepEqual(bArraySystem, cArray);
    assert.ok(Array.isArray(resultArray.system) && resultArray.system.length === 2);
    
    const bNoSystem = MessagesBody.parse({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const cNoSystem = structuredClone(bNoSystem);
    const resultNoSystem = withReadFirstHint(bNoSystem);
    assert.deepEqual(bNoSystem, cNoSystem);
    assert.ok(typeof resultNoSystem.system === 'string' && resultNoSystem.system.includes('Before answering'));
  });

  describe('6) e2e with a stub classifier', () => {
    let anthropic: { server: Server; url: string };
    let cheap: { server: Server; url: string };
    let proxy: FastifyInstance;
    let proxyUrl: string;
    let anthropicLog: Seen[] = [];
    let cheapLog: Seen[] = [];
    let anthropicHandler: Handler = anthropicOk;
    let cheapHandler: Handler = openAiStream;
    let db: TelemetryDb;
    let telemetry: SqliteTelemetry;

    async function startServer(env: NodeJS.ProcessEnv) {
      if (proxy) await proxy.close();
      if (telemetry) await telemetry.close();
      
      const config = loadConfig(env);
      const classifier = new ScriptedClassifier(() => SIMPLE);
      const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
        policy: { minCheapProbability: config.router.minCheapProbability, standardRoute: config.router.standardRoute },
        primaryClasses: config.router.primaryClasses,
        cheapContextTokens: 100_000,
        classifierTimeoutMs: 1_000,
        classifierMaxChars: 4_000,
      });
      db = openTelemetryDb(':memory:');
      telemetry = new SqliteTelemetry(db, { flushIntervalMs: 60_000 });
      proxy = buildServer({
        config,
        router,
        providers: { primary: new AnthropicProvider(config.primary), cheap: new OpenAICompatibleProvider(config.cheap) },
        telemetry,
      });
      await proxy.listen({ host: '127.0.0.1', port: 0 });
      proxyUrl = 'http://127.0.0.1:' + (proxy.server.address() as AddressInfo).port;
    }

    before(async () => {
      anthropic = await fakeServer(() => anthropicHandler, anthropicLog);
      cheap = await fakeServer(() => cheapHandler, cheapLog);
    });

    after(async () => {
      if (proxy) await proxy.close();
      if (telemetry) await telemetry.close();
      anthropic.server.close();
      cheap.server.close();
    });

    beforeEach(() => {
      anthropicLog.length = 0;
      cheapLog.length = 0;
      anthropicHandler = anthropicOk;
      cheapHandler = openAiStream;
    });

    const claudeCode = (text: string, tools: boolean = true) =>
      request(proxyUrl + '/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-client',
          'anthropic-version': '2023-06-01',
          'x-claude-code-session-id': 'sess-' + Math.random(),
        },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 100,
          system: 'foo',
          stream: true,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          tools: tools ? [{ name: 'Read', input_schema: { type: 'object', properties: {} } }] : undefined
        }),
      });

    it('adds read-first hint on cheap route', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_READ_FIRST_HINT: 'true',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('What should we do next?');
      await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.equal(cheapLog.length, 1);
      assert.ok(cheapLog[0]!.body.messages[0].content.includes('Before answering'), 'Cheap provider gets the hint in system prompt');
      assert.equal(anthropicLog.length, 0);
    });

    it('does not add read-first hint when CHEAP_READ_FIRST_HINT=false', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_READ_FIRST_HINT: 'false',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('What should we do next?');
      await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.equal(cheapLog.length, 1);
      assert.ok(!cheapLog[0]!.body.messages[0].content.includes('Before answering'));
    });

    it('when cheap fails, anthropic receives body without the hint', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_READ_FIRST_HINT: 'true',
        CHEAP_RETRY: 'true',
        CHEAP_RETRY_DELAY_MS: '1',
        LOG_LEVEL: 'fatal',
      });
      cheapHandler = openAi503; // Fail twice -> fallback
      const res = await claudeCode('What should we do next?');
      await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.equal(cheapLog.length, 2);
      assert.equal(anthropicLog.length, 1);
      
      const aBody = anthropicLog[0]!.body;
      assert.equal(aBody.system, 'foo', 'Anthropic system prompt remains unchanged');
      assert.ok(anthropicLog[0]!.raw.includes('"system":"foo"'), 'Anthropic raw bytes do not contain the hint');
      assert.ok(!anthropicLog[0]!.raw.includes('Before answering'));
    });

    it('2) inspection miss', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        LOG_LEVEL: 'fatal',
      });

      // (a) a fresh substantive turn with a Read tool, cheap answers plain text ending with a period and no tool call
      cheapHandler = async (_seen, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Here is some plain text."}}]}\n\n');
        await sleep(10);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\n');
        res.end('data: [DONE]\n\n');
      };
      
      let res = await claudeCode('I need help with this bug.', true);
      await res.body.text();

      // (b) a fresh turn 'valeu, ficou top' with a Read tool -> inspection_miss 0
      cheapHandler = async (_seen, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"You are welcome."}}]}\n\n');
        await sleep(10);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\n');
        res.end('data: [DONE]\n\n');
      };
      
      res = await claudeCode('valeu, ficou top', true);
      await res.body.text();

      // (c) a fresh substantive turn where the cheap answer ends with '?' -> inspection_miss 0
      cheapHandler = async (_seen, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Do you need more help?"}}]}\n\n');
        await sleep(10);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\n');
        res.end('data: [DONE]\n\n');
      };
      
      res = await claudeCode('What about this?', true);
      await res.body.text();

      // (d) a tool-result continuation (messages: user text, assistant tool_use, user tool_result) where cheap answers plain text -> inspection_miss 0
      cheapHandler = async (_seen, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Understood."}}]}\n\n');
        await sleep(10);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":5}}\n\n');
        res.end('data: [DONE]\n\n');
      };
      
      res = await request(proxyUrl + '/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-client',
          'anthropic-version': '2023-06-01',
          'x-claude-code-session-id': 'sess-' + Math.random(),
        },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 100,
          system: 'foo',
          stream: true,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'help' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
          ],
          tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
        }),
      });
      await res.body.text();

      await telemetry.flush();
      const stats = computeStats(db);
      assert.equal(stats.inspectionMisses, 1);
    });
  });
});
