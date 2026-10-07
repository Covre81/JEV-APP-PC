import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { HeuristicClassifier } from '../src/classifier/heuristic-classifier.js';
import { loadConfig } from '../src/config.js';
import type { Route } from '../src/domain/policy.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { CheapHealth, type CheapState } from '../src/providers/cheap-health.js';
import { OpenAICompatibleProvider } from '../src/providers/openai/provider.js';
import { buildServer } from '../src/proxy/server.js';
import { Router } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';

async function listen(handler: (url: string, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req.url!, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (server: Server) =>
  new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });

describe('CheapHealth', () => {
  let status = 200;
  let models: { server: Server; url: string };
  const seen: string[] = [];

  before(async () => {
    models = await listen((url, res) => {
      seen.push(url);
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"data":[]}');
    });
  });
  after(() => close(models.server));

  it('starts unknown, then follows GET /models', async () => {
    const health = new CheapHealth({ baseUrl: `${models.url}/v1`, apiKey: 'k', intervalMs: 60_000 });
    assert.equal(health.state, 'unknown');
    status = 200;
    assert.equal(await health.check(), 'up');
    assert.equal(seen.at(-1), '/v1/models');
    status = 503;
    assert.equal(await health.check(), 'down');
    status = 200;
    assert.equal(await health.check(), 'up');
  });

  it('is down when nothing listens', async () => {
    const health = new CheapHealth({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', intervalMs: 60_000 });
    assert.equal(await health.check(), 'down');
  });

  it('is down when the daemon accepts but never answers', { timeout: 2_000 }, async () => {
    const hung = createServer(() => {});
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/v1`;
      const health = new CheapHealth({ baseUrl: url, apiKey: 'k', intervalMs: 60_000, timeoutMs: 100 });
      assert.equal(await health.check(), 'down');
    } finally {
      await close(hung);
    }
  });

  it('start() waits for the first answer, at most bootWaitMs, and reports changes', async () => {
    status = 200;
    const changes: CheapState[] = [];
    const health = new CheapHealth({
      baseUrl: `${models.url}/v1`,
      apiKey: 'k',
      intervalMs: 60_000,
      onChange: (s) => changes.push(s),
    });
    await health.start(2_000);
    health.stop();
    assert.equal(health.state, 'up');
    assert.deepEqual(changes, ['up']);
  });
});

describe('cheap route while the cheap provider is down', () => {
  let anthropic: { server: Server; url: string };
  let cheap: { server: Server; url: string };
  let proxy: FastifyInstance;
  let proxyUrl: string;
  const cheapHits: string[] = [];
  const health: { state: CheapState } = { state: 'down' };

  before(async () => {
    anthropic = await listen((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    cheap = await listen((url, res) => {
      cheapHits.push(url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
    });
    const config = loadConfig({
      CLASSIFIER: 'heuristic',
      ANTHROPIC_UPSTREAM_URL: anthropic.url,
      CHEAP_BASE_URL: `${cheap.url}/v1`,
      CHEAP_API_KEY: 'k',
      LOG_LEVEL: 'fatal',
    });
    const router = new Router(new HeuristicClassifier(), new TtlLruStore<Route>(100, 60_000), {
      policy: { minCheapProbability: 0.8, standardRoute: 'primary' },
      primaryClasses: config.router.primaryClasses,
      cheapContextTokens: 100_000,
      classifierTimeoutMs: 1_000,
      classifierMaxChars: 4_000,
    });
    proxy = buildServer({
      config,
      router,
      providers: { primary: new AnthropicProvider(config.primary), cheap: new OpenAICompatibleProvider(config.cheap) },
      cheapHealth: health,
    });
    await proxy.listen({ host: '127.0.0.1', port: 0 });
    proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await proxy.close();
    await close(anthropic.server);
    await close(cheap.server);
  });

  const send = (messages: unknown[]) =>
    request(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, messages }),
    });

  const first = { role: 'user', content: [{ type: 'text', text: 'fix the typo in the README' }] };

  it('sends the turn to Claude without an attempt, and without pinning the conversation there', async () => {
    health.state = 'down';
    const skipped = await send([first]);
    await skipped.body.text();
    assert.equal(skipped.statusCode, 200);
    assert.equal(skipped.headers['x-jev-route'], 'primary; reason=skipped:cheap-unhealthy');
    assert.equal(cheapHits.length, 0, 'no wasted attempt on a provider known to be down');

    // The provider is back: the same conversation's next request may go cheap again.
    health.state = 'up';
    const next = await send([
      first,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Teh readme' }] },
    ]);
    await next.body.text();
    assert.equal(next.headers['x-jev-route'], 'cheap; reason=sticky');
    assert.equal(cheapHits.length, 1);
  });

  it('reports the cheap state, pid and start time on /healthz', async () => {
    health.state = 'down';
    const res = await request(`${proxyUrl}/healthz`);
    const body = (await res.body.json()) as Record<string, unknown>;
    assert.equal(res.statusCode, 200);
    assert.equal(body['ok'], true);
    assert.equal(body['cheap'], 'down');
    assert.equal(body['pid'], process.pid);
    assert.equal(typeof body['startedAt'], 'string');
    assert.equal(body['sha'], null, 'no build info injected');
  });
});
