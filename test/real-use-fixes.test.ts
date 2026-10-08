import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { HeuristicClassifier } from '../src/classifier/heuristic-classifier.js';
import { loadConfig } from '../src/config.js';
import type { Tier } from '../src/domain/policy.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai/provider.js';
import { buildServer, isQuotaProbe, failureCode } from '../src/proxy/server.js';
import { Router } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';
import { openTelemetryDb, type TelemetryDb } from '../src/telemetry/db.js';
import { SqliteTelemetry } from '../src/telemetry/recorder.js';
import type { RouterLog } from '../src/telemetry/schema.js';

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
  res.write(
    `event: message_start\ndata: {"type":"message_start","message":{"model":"${seen.body?.model ?? 'claude-opus-5'}","usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}\n\n`,
  );
  await sleep(10);
  res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n`);
  res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
};

const anthropic429: Handler = (_seen, res) => {
  res.writeHead(429, { 
    'content-type': 'application/json', 
    'retry-after': '30',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '1.0'
  });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } }));
};

const anthropic529: Handler = (_seen, res) => {
  res.writeHead(529, { 
    'content-type': 'application/json', 
    'retry-after': '30',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '1.0'
  });
  res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }));
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

const openAi500: Handler = (_seen, res) => {
  res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"internal error"}}');
};

const openAi400: Handler = (_seen, res) => {
  res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"bad request"}}');
};

const openAiCutMidStream: Handler = (_seen, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
};

describe('real-use fixes (A and C)', () => {
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
    const router = new Router(new HeuristicClassifier(), new TtlLruStore<Tier>(100, 60_000), {
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
    proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
  }

  before(async () => {
    anthropic = await fakeServer(() => anthropicHandler, anthropicLog);
    cheap = await fakeServer(() => cheapHandler, cheapLog);

    await startServer({
      CLASSIFIER: 'heuristic',
      ROUTER_MIN_CHEAP_PROBABILITY: '0.8',
      ANTHROPIC_UPSTREAM_URL: anthropic.url,
      CHEAP_BASE_URL: `${cheap.url}/openai/v1`,
      CHEAP_API_KEY: 'gsk_test',
      FAILOVER_ON_PRIMARY_RATE_LIMIT: 'true',
      CHEAP_RETRY_DELAY_MS: '10',
      LOG_LEVEL: 'fatal',
    });
  });

  after(async () => {
    await proxy.close();
    await telemetry.close();
    anthropic.server.close();
    cheap.server.close();
  });

  beforeEach(() => {
    anthropicLog.length = 0;
    cheapLog.length = 0;
    anthropicHandler = anthropicOk;
    cheapHandler = openAiStream;
  });

  const claudeCode = (sessionId: string, maxTokens: number, classHdr: string, text = 'fix the typo in the README') =>
    request(`${proxyUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-client',
        'anthropic-version': '2023-06-01',
        'x-claude-code-session-id': sessionId,
        'x-claude-code-request-class': classHdr,
      },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      }),
    });

  async function logsFor(sessionId: string): Promise<any[]> {
    for (let i = 0; i < 20; i++) {
      await sleep(10);
      telemetry.flush();
      const rows = db.prepare(`SELECT * FROM router_logs WHERE session_id LIKE ? ORDER BY id`).all(`${sessionId}:%`) as any[];
      if (rows.length > 0) return rows;
    }
    return [];
  }

  it('1) probe 429 passes through', async () => {
    anthropicHandler = anthropic429;
    const res = await claudeCode('probe-429', 1, 'auxiliary', 'probe');
    const bodyText = await res.body.text();
    
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '30');
    assert.equal(res.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(res.headers['anthropic-ratelimit-unified-7d-utilization'], '1.0');
    assert.deepEqual(JSON.parse(bodyText), { type: 'error', error: { type: 'rate_limit_error', message: 'quota' } });
    assert.equal(cheapLog.length, 0);

    let row;
    for (let i = 0; i < 20; i++) {
      await sleep(10);
      telemetry.flush();
      const rows = db.prepare(`SELECT * FROM router_logs WHERE request_class = 'auxiliary' ORDER BY id DESC`).all() as any[];
      if (rows.length > 0) { row = rows[0]; break; }
    }

    assert.ok(row);
    assert.equal(row.http_status, 429);
    assert.equal(row.upstream_status, 429);
    assert.ok(row.upstream_ratelimit_headers.includes('anthropic-ratelimit-unified-status'));
    assert.ok(row.upstream_ratelimit_headers.includes('anthropic-ratelimit-unified-7d-utilization'));
    assert.ok(!row.upstream_ratelimit_headers.includes('1.0'), 'no header value in column');
    assert.ok(!row.upstream_ratelimit_headers.includes('rejected'), 'no header value in column');
  });

  it('2) probe 529 passes through', async () => {
    anthropicHandler = anthropic529;
    const res = await claudeCode('probe-529', 1, 'main', 'probe');
    const bodyText = await res.body.text();
    
    assert.equal(res.statusCode, 529);
    assert.deepEqual(JSON.parse(bodyText), { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } });
    assert.equal(cheapLog.length, 0);

    const [row] = await logsFor('probe-529');
    assert.ok(row);
    assert.equal(row.http_status, 529);
    assert.equal(row.upstream_status, 529);
    assert.ok(row.upstream_ratelimit_headers.includes('anthropic-ratelimit-unified-status'));
  });

  it('3) normal request 429 fails over to cheap', async () => {
    anthropicHandler = anthropic429;
    const res = await claudeCode('normal-429', 64000, 'main', 'refactor the data layer to clean architecture');
    await res.body.text();
    
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-jev-route'], 'cheap; reason=failover:primary-rate-limited');
    assert.equal(cheapLog.length, 1);
    assert.equal(anthropicLog.length, 1);

    const [row] = await logsFor('normal-429');
    assert.ok(row);
    assert.equal(row.upstream_status, 429);
    assert.ok(row.upstream_ratelimit_headers.includes('anthropic-ratelimit-unified-status'));
  });

  it('4) cheap answers 503 twice, fails over', async () => {
    cheapHandler = openAi503;
    const res = await claudeCode('cheap-503-x2', 64000, 'main', 'fix the typo in the README');
    await res.body.text();
    
    assert.equal(res.statusCode, 200);
    assert.equal(cheapLog.length, 2);
    assert.equal(anthropicLog.length, 1);

    const [row] = await logsFor('cheap-503-x2');
    assert.ok(row);
    assert.equal(row.fallback_triggered, 1);
    assert.equal(row.upstream_failure, 'retried: HTTP 503');
    assert.equal(row.upstream_status, 503);
    assert.equal(row.upstream_failure.includes('over capacity'), false);
    assert.equal(row.upstream_ratelimit_headers?.includes('over capacity') ?? false, false);
  });

  it('5) cheap answers 500 once then streams OK', async () => {
    let callCount = 0;
    cheapHandler = (seen, res) => {
      callCount++;
      if (callCount === 1) return openAi500(seen, res);
      return openAiStream(seen, res);
    };
    
    const res = await claudeCode('cheap-500-ok', 64000, 'main', 'fix the typo in the README');
    await res.body.text();
    
    assert.equal(res.statusCode, 200);
    assert.equal(cheapLog.length, 2);
    assert.equal(anthropicLog.length, 0);

    const [row] = await logsFor('cheap-500-ok');
    assert.ok(row);
    assert.equal(row.upstream_failure, 'retried: HTTP 500');
    assert.equal(row.http_status, 200);
  });

  it('6) CHEAP_RETRY=false: cheap 500 once -> fails over', async () => {
    await startServer({
      CLASSIFIER: 'heuristic',
      ROUTER_MIN_CHEAP_PROBABILITY: '0.8',
      ANTHROPIC_UPSTREAM_URL: anthropic.url,
      CHEAP_BASE_URL: `${cheap.url}/openai/v1`,
      CHEAP_API_KEY: 'gsk_test',
      CHEAP_RETRY: 'false',
      LOG_LEVEL: 'fatal',
    });

    cheapHandler = openAi500;
    const res = await claudeCode('cheap-no-retry', 64000, 'main', 'fix the typo in the README');
    await res.body.text();
    
    assert.equal(res.statusCode, 200);
    assert.equal(cheapLog.length, 1);
    assert.equal(anthropicLog.length, 1);
  });

  it('7) cheap answers 400: no retry, fails over', async () => {
    // restart server with default retry config
    await startServer({
      CLASSIFIER: 'heuristic',
      ROUTER_MIN_CHEAP_PROBABILITY: '0.8',
      ANTHROPIC_UPSTREAM_URL: anthropic.url,
      CHEAP_BASE_URL: `${cheap.url}/openai/v1`,
      CHEAP_API_KEY: 'gsk_test',
      LOG_LEVEL: 'fatal',
    });

    cheapHandler = openAi400;
    const res = await claudeCode('cheap-400', 64000, 'main', 'fix the typo in the README');
    await res.body.text();
    
    assert.equal(res.statusCode, 200);
    assert.equal(cheapLog.length, 1);
    assert.equal(anthropicLog.length, 1);
  });

  it('8) a cheap stream cut mid-way is not retried', async () => {
    cheapHandler = openAiCutMidStream;
    const res = await claudeCode('cheap-cut', 64000, 'main', 'fix the typo in the README');
    await res.body.text();
    
    assert.equal(cheapLog.length, 1);
  });

  describe('9) unit tests', () => {
    it('isQuotaProbe', () => {
      assert.equal(isQuotaProbe({ max_tokens: 1 } as any), true);
      assert.equal(isQuotaProbe({ max_tokens: 2 } as any), false);
      assert.equal(isQuotaProbe(undefined), false);
    });

    it('failureCode', () => {
      assert.equal(failureCode('HTTP 500: {...}'), 'HTTP 500');
      assert.equal(failureCode('network: connect ECONNREFUSED'), 'network');
      assert.equal(failureCode('network: upstream response headers deadline exceeded'), 'timeout');
      assert.equal(failureCode('not translatable: x'), 'not translatable');
      assert.equal(failureCode('bad response: y'), 'bad response');
    });
  });

  describe('10) config', () => {
    it('defaults', () => {
      const c = loadConfig({
        CLASSIFIER: 'heuristic',
        CHEAP_API_KEY: 'x',
      });
      assert.equal(c.cheapRetry.enabled, true);
      assert.equal(c.cheapRetry.delayMs, 250);
      assert.equal(c.cheapRetry.headersTimeoutMs, 15000);
    });

    it('parses CHEAP_RETRY=false', () => {
      const c = loadConfig({
        CLASSIFIER: 'heuristic',
        CHEAP_API_KEY: 'x',
        CHEAP_RETRY: 'false',
      });
      assert.equal(c.cheapRetry.enabled, false);
    });
  });
});
