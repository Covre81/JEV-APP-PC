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
import { READ_FIRST_HINT, needsReadFirstHint, withReadFirstHint, matchesReadFirstText, needsReadFirstFollowup } from '../src/routing/read-first-hint.js';
import { MessagesBody } from '../src/routing/messages-body.js';
import type { ClassificationInput, ComplexityClassifier } from '../src/classifier/classifier.js';
import type { ComplexityDistribution } from '../src/domain/complexity.js';
import { toAnthropicMessage, toAnthropicStream } from '../src/providers/openai/translate-response.js';
import { Readable } from 'node:stream';

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
const STRUCTURAL: ComplexityDistribution = { simple: 0.02, standard: 0.06, structural: 0.92 };

class ScriptedClassifier implements ComplexityClassifier {
  readonly name = 'scripted';
  calls: ClassificationInput[] = [];
  constructor(public next: () => ComplexityDistribution | Error) {}
  classify(input: ClassificationInput): Promise<ComplexityDistribution> {
    this.calls.push(input);
    const r = this.next();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

describe('Read First D2 changes', () => {
  describe('a) withReadFirstHint placement', () => {
    it('appends to string content of last user message', () => {
      const bString = MessagesBody.parse({ model: 'x', messages: [{ role: 'user', content: 'hi' }], system: 'A' });
      const origString = structuredClone(bString);
      const res = withReadFirstHint(bString);
      assert.deepEqual(bString, origString, 'Input object must not be mutated');
      assert.equal(res.system, 'A', 'System unchanged');
      assert.deepEqual(res.messages[0]!.content, [
        { type: 'text', text: 'hi' },
        { type: 'text', text: '<system-reminder>\n' + READ_FIRST_HINT + '\n</system-reminder>' }
      ]);
    });

    it('appends to block content of last user message', () => {
      const bBlock = MessagesBody.parse({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
      const origBlock = structuredClone(bBlock);
      const res = withReadFirstHint(bBlock);
      assert.deepEqual(bBlock, origBlock);
      assert.deepEqual(res.messages[0]!.content, [
        { type: 'text', text: 'hi' },
        { type: 'text', text: '<system-reminder>\n' + READ_FIRST_HINT + '\n</system-reminder>' }
      ]);
    });

    it('leaves non-user last message unchanged', () => {
      const bNon = MessagesBody.parse({
        model: 'x',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' }
        ]
      });
      const orig = structuredClone(bNon);
      const res = withReadFirstHint(bNon);
      assert.deepEqual(res, orig);
    });
  });

  describe('e2e router proxy', () => {
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
    let classifier: ScriptedClassifier;

    async function startServer(env: NodeJS.ProcessEnv) {
      if (proxy) await proxy.close();
      if (telemetry) await telemetry.close();
      
      const config = loadConfig(env);
      if (!classifier) {
        classifier = new ScriptedClassifier(() => SIMPLE);
      }
      const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
        policy: {
          minCheapProbability: config.router.minCheapProbability,
          standardRoute: config.router.standardRoute,
          standardEnabled: config.cheapStandard !== undefined,
          minStandardProbability: config.router.minStandardProbability,
        },
        primaryClasses: config.router.primaryClasses,
        cheapContextTokens: 100_000,
        ...(config.cheapStandard ? { standardContextTokens: 200_000 } : {}),
        classifierTimeoutMs: 1_000,
        classifierMaxChars: 4_000,
        readFirstStandard: config.cheapReadFirstHint && config.readFirstStandard && config.cheapStandard !== undefined,
        ...(config.gemini ? { geminiPolicy: { enabled: true, minTextOnly: 0.8, pressureMinTextOnly: 0.6 } } : {}),
        geminiFromPrimary: true,
      });
      db = openTelemetryDb(':memory:');
      telemetry = new SqliteTelemetry(db, { flushIntervalMs: 60_000 });
      proxy = buildServer({
        config,
        router,
        providers: {
          primary: new AnthropicProvider(config.primary),
          cheap: new OpenAICompatibleProvider(config.cheap),
          ...(config.cheapStandard ? { standard: new OpenAICompatibleProvider({ ...config.cheap, model: config.cheapStandard.model }) } : {}),
        },
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
      classifier = undefined as any;
    });

    const claudeCode = (text: string, sessionId = 's-' + Math.random(), tools: boolean = true) =>
      request(proxyUrl + '/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-client',
          'anthropic-version': '2023-06-01',
          'x-claude-code-session-id': sessionId,
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

    it('b) standard promotion for read-first turn', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b-cloud',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('estou pensando o que eu deviria fazer agora');
      const text = await res.body.text();
      assert.equal(res.statusCode, 200, text);
      assert.equal(res.headers['x-jev-route'], 'cheap; reason=read-first:standard');
      assert.equal(cheapLog.length, 1);
      assert.equal(cheapLog[0]!.body.model, 'gemma4:31b-cloud'); // standard model
      const msgs = cheapLog[0]!.body.messages;
      const lastMsg = msgs[msgs.length - 1];
      assert.ok(lastMsg.content.includes('<system-reminder>'), 'Reminder in last user message');
      assert.ok(!cheapLog[0]!.body.system?.includes('<system-reminder>'), 'Not in system message');
    });

    it('c) standard disabled -> trivial model gets reminder', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'off',
        CHEAP_MODEL: 'gpt-oss:20b-cloud',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('estou pensando o que eu deviria fazer agora');
      await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-jev-route'], 'cheap; reason=classified'); // remains trivial
      assert.equal(cheapLog.length, 1);
      assert.equal(cheapLog[0]!.body.model, 'gpt-oss:20b-cloud');
      const msgs = cheapLog[0]!.body.messages;
      assert.ok(msgs[msgs.length - 1].content.includes('<system-reminder>'));
    });

    it('d) standard promotion disabled explicitly', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b-cloud',
        CHEAP_READ_FIRST_STANDARD: 'false',
        CHEAP_MODEL: 'gpt-oss:20b-cloud',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('estou pensando o que eu deviria fazer agora');
      await res.body.text();
      assert.equal(res.headers['x-jev-route'], 'cheap; reason=classified');
      assert.equal(cheapLog.length, 1);
      assert.equal(cheapLog[0]!.body.model, 'gpt-oss:20b-cloud');
      const msgs = cheapLog[0]!.body.messages;
      assert.ok(msgs[msgs.length - 1].content.includes('<system-reminder>'));
    });

    it('d) hint entirely disabled', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b-cloud',
        CHEAP_READ_FIRST_HINT: 'false',
        CHEAP_MODEL: 'gpt-oss:20b-cloud',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('estou pensando o que eu deviria fazer agora');
      await res.body.text();
      assert.equal(res.headers['x-jev-route'], 'cheap; reason=classified');
      assert.equal(cheapLog.length, 1);
      assert.equal(cheapLog[0]!.body.model, 'gpt-oss:20b-cloud');
      assert.ok(!cheapLog[0]!.raw.includes('<system-reminder>'));
    });

    it('e) non-matching fresh turn stays trivial', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b-cloud',
        CHEAP_MODEL: 'gpt-oss:20b-cloud',
        LOG_LEVEL: 'fatal',
      });
      const res = await claudeCode('fix the typo in the README');
      await res.body.text();
      assert.equal(res.headers['x-jev-route'], 'cheap; reason=classified');
      assert.equal(cheapLog.length, 1);
      assert.equal(cheapLog[0]!.body.model, 'gpt-oss:20b-cloud');
      assert.ok(!cheapLog[0]!.raw.includes('<system-reminder>'));
    });

    it('f) primary proposal stays primary without reminder', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b-cloud',
        LOG_LEVEL: 'fatal',
      });
      classifier.next = () => STRUCTURAL; // routes to primary
      const res = await claudeCode('estou pensando o que eu deviria fazer agora');
      await res.body.text();
      assert.equal(res.headers['x-jev-route'], 'primary; reason=classified');
      assert.equal(cheapLog.length, 0);
      assert.equal(anthropicLog.length, 1);
      assert.ok(!anthropicLog[0]!.raw.includes('<system-reminder>'), 'Raw bytes unaltered');
    });

    it('g) standard fallback to trivial', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b-cloud',
        CHEAP_MODEL: 'gpt-oss:20b-cloud',
        CHEAP_RETRY: 'true',
        CHEAP_RETRY_DELAY_MS: '1',
        LOG_LEVEL: 'fatal',
      });
      
      let calls = 0;
      cheapHandler = async (seen, res) => {
        if (seen.body.model === 'gemma4:31b-cloud') {
          calls++;
          res.writeHead(500, { 'content-type': 'application/json' }).end('{"error": "ded"}');
        } else {
          await openAiStream(seen, res);
        }
      };

      const sid = 's-' + Math.random();
      const res = await claudeCode('estou pensando o que eu deviria fazer agora', sid);
      await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.equal(calls, 2, 'Retried once on standard tier');
      assert.equal(res.headers['x-jev-route'], 'cheap; reason=failover:standard-unavailable');
      assert.equal(cheapLog[2]!.body.model, 'gpt-oss:20b-cloud'); // fallback trivial

      // Next turn should be sticky to trivial
      const res2 = await request(proxyUrl + '/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-client',
          'anthropic-version': '2023-06-01',
          'x-claude-code-session-id': sid,
        },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 100,
          system: 'foo',
          stream: true,
          messages: [
            { role: 'user', content: 'estou pensando o que eu deviria fazer agora' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'next tool' }
          ]
        }),
      });
      await res2.body.text();
      assert.equal(res2.headers['x-jev-route'], 'cheap; reason=sticky');
      assert.equal(cheapLog[3]!.body.model, 'gpt-oss:20b-cloud');
    });

    it('h1) Gemini tier enabled and the classifier stub proposes a trivial tier for a fresh \'estou pensando o que eu deviria fazer agora\' turn with a Read tool -> the turn goes to the standard tier with reason read-first:standard', async () => {
      const classifier = new ScriptedClassifier(() => ({ simple: 1.0, standard: 0, structural: 0, textOnly: 1.0 }));
      const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
        policy: { minCheapProbability: 0.5, standardRoute: 'cheap', standardEnabled: true, minStandardProbability: 0.5 },
        primaryClasses: new Set(),
        cheapContextTokens: 100_000,
        standardContextTokens: 200_000,
        classifierTimeoutMs: 1000,
        classifierMaxChars: 4000,
        readFirstStandard: true,
        geminiPolicy: { enabled: true, minTextOnly: 0.8, pressureMinTextOnly: 0.6 },
        geminiFromPrimary: true,
      });

      const res = await router.decide({
        body: MessagesBody.parse({
          model: 'claude',
          messages: [{ role: 'user', content: 'estou pensando o que eu deviria fazer agora' }],
          tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
        }),
        rawByteLength: 100,
        sessionId: 's-1',
        agentId: undefined,
        requestClass: undefined,
        contextCompacted: false,
      });

      assert.equal(res.route, 'cheap');
      assert.equal(res.reason, 'read-first:standard');
      assert.equal(res.tier, 'standard');
    });

    it('h2) Gemini tier enabled and the stub distribution makes the turn Gemini-eligible for the same read-first text -> the decision is the Gemini route', async () => {
      const classifier = new ScriptedClassifier(() => ({ simple: 0, standard: 0, structural: 1.0, textOnly: 1.0 }));
      const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
        policy: { minCheapProbability: 0.5, standardRoute: 'cheap', standardEnabled: true, minStandardProbability: 0.5 },
        primaryClasses: new Set(),
        cheapContextTokens: 100_000,
        standardContextTokens: 200_000,
        classifierTimeoutMs: 1000,
        classifierMaxChars: 4000,
        readFirstStandard: true,
        geminiPolicy: { enabled: true, minTextOnly: 0.8, pressureMinTextOnly: 0.6 },
        geminiFromPrimary: true,
      });

      const res = await router.decide({
        body: MessagesBody.parse({
          model: 'claude',
          messages: [{ role: 'user', content: 'estou pensando o que eu deviria fazer agora' }],
          tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
        }),
        rawByteLength: 100,
        sessionId: 's-2',
        agentId: undefined,
        requestClass: undefined,
        contextCompacted: false,
      });

      assert.equal(res.route, 'gemini');
      assert.equal(res.tier, 'gemini');
      assert.equal(res.reason, 'gemini:text-only');
    });
  });

  describe('read-first follow-up', () => {
    it('unit tests for matchesReadFirstText and needsReadFirstFollowup', () => {
      const makeBody = (messages: any[], tools: any[] = [{ name: 'Read' }]) => ({ model: 'x', tools, messages });

      const msgUser1 = { role: 'user', content: 'estou pensando o que eu deviria fazer agora' };
      const msgAsstLS = { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'LS', input: {} }] };
      const msgToolRes = { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'foo' }] };

      assert.equal(matchesReadFirstText('estou pensando o que eu deviria fazer agora'), true);

      // 1. true for [user 'estou pensando o que eu deviria fazer agora', assistant tool_use LS, user tool_result]
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstLS, msgToolRes])), true);

      // 2. false when an assistant tool_use Read already happened
      const msgAsstRead = { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'Read', input: {} }] };
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstRead, msgToolRes])), false);

      // 3. false when the Bash command is 'cat docs/PLANO.md'
      const msgAsstCat = { role: 'assistant', content: [{ type: 'tool_use', id: '3', name: 'Bash', input: { command: 'cat docs/PLANO.md' } }] };
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstCat, msgToolRes])), false);

      // 4. true when the Bash command is 'ls'
      const msgAsstBashLs = { role: 'assistant', content: [{ type: 'tool_use', id: '4', name: 'Bash', input: { command: 'ls' } }] };
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstBashLs, msgToolRes])), true);

      // 5. false when a second human text message exists
      const msgUser2 = { role: 'user', content: 'anything else' };
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstLS, msgToolRes, msgAsstLS, msgUser2, msgAsstLS, msgToolRes])), false);

      // 6. false when the first human text does not match ('fix the typo in the README')
      const msgUserTypo = { role: 'user', content: 'fix the typo in the README' };
      assert.equal(needsReadFirstFollowup(makeBody([msgUserTypo, msgAsstLS, msgToolRes])), false);

      // 7. false when the last message has no tool_result
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstLS, { role: 'user', content: 'no result' }])), false);

      // 8. false with 7 assistant messages
      const msgs7: any[] = [msgUser1];
      for (let i = 0; i < 7; i++) {
        msgs7.push(msgAsstLS, msgToolRes);
      }
      assert.equal(needsReadFirstFollowup(makeBody(msgs7)), false);

      // 9. false without a Read tool offered
      assert.equal(needsReadFirstFollowup(makeBody([msgUser1, msgAsstLS, msgToolRes], [])), false);

      // 10. true when the first user message is a block array with a system-reminder block followed by the human text block
      const msgUserReminder = { role: 'user', content: [
        { type: 'text', text: '<system-reminder>\nblabla\n</system-reminder>' },
        { type: 'text', text: 'estou pensando o que eu deviria fazer agora' }
      ] };
      assert.equal(needsReadFirstFollowup(makeBody([msgUserReminder, msgAsstLS, msgToolRes])), true);
    });
  });

  describe('e2e follow-up proxy tests', () => {
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
        policy: {
          minCheapProbability: config.router.minCheapProbability,
          standardRoute: config.router.standardRoute,
          standardEnabled: config.cheapStandard !== undefined,
          minStandardProbability: config.router.minStandardProbability,
        },
        primaryClasses: config.router.primaryClasses,
        cheapContextTokens: 100_000,
        ...(config.cheapStandard ? { standardContextTokens: 200_000 } : {}),
        classifierTimeoutMs: 1_000,
        classifierMaxChars: 4_000,
        readFirstStandard: config.cheapReadFirstHint && config.readFirstStandard && config.cheapStandard !== undefined,
      });
      db = openTelemetryDb(':memory:');
      telemetry = new SqliteTelemetry(db, { flushIntervalMs: 60_000 });
      proxy = buildServer({
        config,
        router,
        providers: {
          primary: new AnthropicProvider(config.primary),
          cheap: new OpenAICompatibleProvider(config.cheap),
          ...(config.cheapStandard ? { standard: new OpenAICompatibleProvider({ ...config.cheap, model: config.cheapStandard.model }) } : {}),
        },
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

    const claudeCode = (messages: any[], sessionId = 's-' + Math.random()) =>
      request(proxyUrl + '/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-client',
          'anthropic-version': '2023-06-01',
          'x-claude-code-session-id': sessionId,
        },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 100,
          stream: true,
          messages,
          tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }, { name: 'LS', input_schema: { type: 'object', properties: {} } }]
        }),
      });

    it('trivial tier follow-up text applied', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'off',
        CHEAP_MODEL: 'gpt-oss',
        ROUTER_MIN_CHEAP_PROBABILITY: '0.01',
        LOG_LEVEL: 'fatal',
      });

      const sid = 'test-trivial';
      let res = await claudeCode([{ role: 'user', content: 'estou pensando o que eu deviria fazer agora' }], sid);
      await res.body.text();
      
      const msgs = [
        { role: 'user', content: 'estou pensando o que eu deviria fazer agora' },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'LS', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'foo' }] }
      ];
      res = await claudeCode(msgs, sid);
      await res.body.text();

      assert.equal(cheapLog.length, 2);
      const lastReqMsgs = cheapLog[1]!.body.messages;
      const lastMsg = lastReqMsgs[lastReqMsgs.length - 1];
      const text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
      assert.ok(text.includes('You have not read the project files yet'), 'Follow-up text should be in last user message');
      assert.equal(lastMsg.role, 'user');
      assert.equal(lastReqMsgs[lastReqMsgs.length - 2].role, 'tool');
      assert.equal(cheapLog[1]!.body.model, 'gpt-oss');
    });

    it('standard tier also gets the follow-up text', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'gemma4:31b',
        CHEAP_MODEL: 'gpt-oss',
        ROUTER_MIN_CHEAP_PROBABILITY: '0.01',
        LOG_LEVEL: 'fatal',
      });

      const sid = 'test-standard';
      let res = await claudeCode([{ role: 'user', content: 'estou pensando o que eu deviria fazer agora' }], sid);
      await res.body.text();
      
      const msgs = [
        { role: 'user', content: 'estou pensando o que eu deviria fazer agora' },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'LS', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'foo' }] }
      ];
      res = await claudeCode(msgs, sid);
      await res.body.text();

      assert.equal(cheapLog.length, 2);
      const lastReqMsgs = cheapLog[1]!.body.messages;
      const lastMsg = lastReqMsgs[lastReqMsgs.length - 1];
      const text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
      assert.ok(text.includes('You have not read the project files yet'), 'Follow-up text should be in the standard tier continuation too');
      assert.equal(cheapLog[0]!.body.model, 'gemma4:31b');
      assert.equal(cheapLog[1]!.body.model, 'gemma4:31b');
    });

    it('no follow-up text if CHEAP_READ_FIRST_HINT=false', async () => {
      await startServer({
        CLASSIFIER: 'heuristic',
        ANTHROPIC_UPSTREAM_URL: anthropic.url,
        CHEAP_BASE_URL: cheap.url + '/openai/v1',
        CHEAP_API_KEY: 'gsk_test',
        CHEAP_MODEL_STANDARD: 'off',
        CHEAP_READ_FIRST_HINT: 'false',
        CHEAP_MODEL: 'gpt-oss',
        ROUTER_MIN_CHEAP_PROBABILITY: '0.01',
        LOG_LEVEL: 'fatal',
      });

      const sid = 'test-disabled';
      let res = await claudeCode([{ role: 'user', content: 'estou pensando o que eu deviria fazer agora' }], sid);
      await res.body.text();
      
      const msgs = [
        { role: 'user', content: 'estou pensando o que eu deviria fazer agora' },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'LS', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'foo' }] }
      ];
      res = await claudeCode(msgs, sid);
      await res.body.text();

      assert.equal(cheapLog.length, 2);
      const lastReqMsgs = cheapLog[1]!.body.messages;
      const lastMsg = lastReqMsgs[lastReqMsgs.length - 1];
      const text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
      assert.ok(!text.includes('You have not read the project files yet'), 'Follow-up text should NOT be applied when hint is disabled');
      assert.equal(cheapLog[1]!.body.model, 'gpt-oss');
    });
  });

  describe('6) Reasoning leak guard (toAnthropicMessage / toAnthropicStream)', () => {
    it('JSON completion drops reasoning field', () => {
      const input = {
        id: 'msg_1',
        object: 'chat.completion',
        created: 123,
        model: 'gpt',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Olá',
            reasoning: 'We need to respond...',
            reasoning_content: 'We need to respond...'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      } as any;
      
      const out = toAnthropicMessage(input, 'test');
      assert.deepEqual((out as any).content, [{ type: 'text', text: 'Olá' }]);
    });

    it('Stream drops reasoning chunks and finishes with tool', async () => {
      const chunks = [
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Thinking...' } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning: 'more' } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' }, index: 0 }] } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ];
      
      let events: any[] = [];
      async function* generate() {
        for (const c of chunks) yield JSON.stringify(c);
        yield '[DONE]';
      }
      const stream = toAnthropicStream(generate(), 'm');
      for await (const chunk of stream) {
        if (!chunk.toString().startsWith('event: ')) continue;
        const type = chunk.toString().match(/event: (.+)\n/)?.[1];
        if (type === 'content_block_delta' || type === 'content_block_start') events.push(chunk.toString());
      }
      
      assert.ok(!events.some(e => e.includes('text_delta')), 'Should have no text_delta blocks');
      assert.ok(events.some(e => e.includes('tool_use')), 'Should have tool_use blocks');
    });

    it('Stream drops reasoning chunks and keeps content chunks', async () => {
      const chunks = [
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'Thinking...' } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'Hel' } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning: 'more' } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'lo' } }] },
        { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      
      let texts = '';
      async function* generate() {
        for (const c of chunks) yield JSON.stringify(c);
        yield '[DONE]';
      }
      const stream = toAnthropicStream(generate(), 'm');
      for await (const chunk of stream) {
        const s = chunk.toString();
        const match = s.match(/"text":"([^"]+)"/);
        if (match) texts += match[1];
      }
      
      assert.equal(texts, 'Hello');
    });
  });
});
