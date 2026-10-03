import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { HeuristicClassifier } from '../src/classifier/heuristic-classifier.js';
import { loadConfig } from '../src/config.js';
import type { Route } from '../src/domain/policy.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai/provider.js';
import { buildServer } from '../src/proxy/server.js';
import { Router } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';

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
  res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' });
  res.write(`event: message_start\ndata: {"type":"message_start","message":{"model":"${seen.body.model}"}}\n\n`);
  await sleep(50);
  res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
};

const anthropic429: Handler = (_seen, res) => {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } }));
};

const openAiStream: Handler = async (_seen, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
  await sleep(200);
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end('data: [DONE]\n\n');
};

const openAi503: Handler = (_seen, res) => {
  res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"message":"over capacity"}}');
};

describe('proxy end-to-end (fake Anthropic + fake OpenAI-compatible upstreams)', () => {
  let anthropic: { server: Server; url: string };
  let cheap: { server: Server; url: string };
  let proxy: FastifyInstance;
  let proxyUrl: string;
  let anthropicLog: Seen[] = [];
  let cheapLog: Seen[] = [];
  let anthropicHandler: Handler = anthropicOk;
  let cheapHandler: Handler = openAiStream;

  before(async () => {
    anthropic = await fakeServer(() => anthropicHandler, anthropicLog);
    cheap = await fakeServer(() => cheapHandler, cheapLog);

    const config = loadConfig({
      CLASSIFIER: 'heuristic',
      ANTHROPIC_UPSTREAM_URL: anthropic.url,
      CHEAP_BASE_URL: `${cheap.url}/openai/v1`,
      CHEAP_API_KEY: 'gsk_test',
      FAILOVER_ON_PRIMARY_RATE_LIMIT: 'true',
      LOG_LEVEL: 'fatal',
    });
    const router = new Router(new HeuristicClassifier(), new TtlLruStore<Route>(100, 60_000), {
      policy: { minCheapProbability: config.router.minCheapProbability, standardRoute: config.router.standardRoute },
      allowEscalation: true,
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
    anthropic.server.close();
    cheap.server.close();
  });

  beforeEach(() => {
    anthropicLog.length = 0;
    cheapLog.length = 0;
    anthropicHandler = anthropicOk;
    cheapHandler = openAiStream;
  });

  const claudeCode = (sessionId: string, text: string) =>
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
        stream: true,
        system: [{ type: 'text', text: 'You are Claude Code' }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      }),
    });

  it('serves a simple task from the cheap provider, translated to Anthropic SSE, streamed live', async () => {
    const res = await claudeCode('S-simple', 'fix the typo in the README');
    let firstChunkAt = 0;
    let text = '';
    for await (const chunk of res.body) {
      firstChunkAt ||= Date.now();
      text += chunk.toString();
    }
    const endedAt = Date.now();

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-jev-route'], 'cheap; reason=classified');
    assert.ok(endedAt - firstChunkAt >= 150, 'first event must be relayed before the cheap stream ends');
    assert.match(text, /event: message_start/);
    assert.match(text, /"text_delta","text":"Hi"/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /event: message_stop/);

    assert.equal(anthropicLog.length, 0, 'the primary quota is untouched');
    assert.equal(cheapLog[0]?.url, '/openai/v1/chat/completions');
    assert.equal(cheapLog[0]?.headers.authorization, 'Bearer gsk_test');
    assert.equal(cheapLog[0]?.headers['x-api-key'], undefined, 'Anthropic credentials never leak to the cheap provider');
    assert.equal(cheapLog[0]?.body.model, 'openai/gpt-oss-20b');
  });

  it('sends structural work to Anthropic byte-for-byte', async () => {
    const res = await claudeCode('S-structural', 'refactor the data layer to clean architecture');
    await res.body.text();
    assert.equal(res.headers['x-jev-route'], 'primary; reason=classified');
    assert.equal(res.headers['anthropic-ratelimit-unified-status'], 'allowed');
    assert.equal(cheapLog.length, 0);
    assert.equal(anthropicLog[0]?.body.model, 'claude-opus-5-5');
    assert.equal(anthropicLog[0]?.headers['anthropic-beta'], 'some-future-beta');
    assert.equal(anthropicLog[0]?.headers['x-api-key'], 'sk-ant-client');
  });

  it('fails over to Anthropic when the cheap provider is down, and pins the conversation', async () => {
    cheapHandler = openAi503;
    const res = await claudeCode('S-down', 'fix the typo');
    await res.body.text();
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-jev-route'], 'primary; reason=failover:cheap-unavailable');
    assert.equal(anthropicLog.length, 1);
  });

  it('fails over to the cheap provider when the primary quota is exhausted (opt-in)', async () => {
    anthropicHandler = anthropic429;
    const res = await claudeCode('S-quota', 'refactor the data layer to clean architecture');
    const text = await res.body.text();
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-jev-route'], 'cheap; reason=failover:primary-rate-limited');
    assert.match(text, /"text":"Hi"/);
  });

  it('relays the primary 429 verbatim when the cheap provider cannot help either', async () => {
    anthropicHandler = anthropic429;
    cheapHandler = openAi503;
    const res = await claudeCode('S-both-down', 'refactor everything');
    const body = await res.body.json();
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '30');
    assert.deepEqual(body, { type: 'error', error: { type: 'rate_limit_error', message: 'quota' } });
  });

  it('passes count_tokens and unknown endpoints straight to Anthropic', async () => {
    anthropicHandler = (_s, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":12}');
    const counted = await request(`${proxyUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.deepEqual(await counted.body.json(), { input_tokens: 12 });

    anthropicHandler = anthropicOk;
    const head = await request(`${proxyUrl}/api/hello`, { method: 'HEAD' });
    await head.body.dump();
    assert.equal(head.statusCode, 200);
    assert.deepEqual(
      anthropicLog.map((s) => s.url),
      ['/v1/messages/count_tokens', '/api/hello'],
    );
    assert.equal(cheapLog.length, 0);
  });
});
