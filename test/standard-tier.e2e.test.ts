import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import type { ComplexityClassifier } from '../src/classifier/classifier.js';
import { loadConfig } from '../src/config.js';
import type { ComplexityDistribution } from '../src/domain/complexity.js';
import type { Tier } from '../src/domain/policy.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai/provider.js';
import { buildServer } from '../src/proxy/server.js';
import { Router } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';

const SIMPLE: ComplexityDistribution = { simple: 0.95, standard: 0.04, structural: 0.01 };
const STANDARD: ComplexityDistribution = { simple: 0.4, standard: 0.5, structural: 0.1 };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('standard tier (proxy)', () => {
  let anthropic: Server;
  let cheap: Server;
  let proxy: FastifyInstance;
  let proxyUrl: string;
  const cheapModels: string[] = [];
  let next: ComplexityDistribution = SIMPLE;

  before(async () => {
    anthropic = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(500).end());
    });
    cheap = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        cheapModels.push((JSON.parse(Buffer.concat(parts).toString()) as { model: string }).model);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      });
    });
    const config = loadConfig({
      CLASSIFIER: 'heuristic',
      ANTHROPIC_UPSTREAM_URL: await listen(anthropic),
      CHEAP_BASE_URL: `${await listen(cheap)}/v1`,
      CHEAP_API_KEY: 'k',
      LOG_LEVEL: 'fatal',
    });
    assert.equal(config.cheapStandard?.model, 'gemma4:31b-cloud', 'on by default');
    const classifier: ComplexityClassifier = { name: 'scripted', classify: async () => next };
    const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
      policy: {
        minCheapProbability: config.router.minCheapProbability,
        standardRoute: config.router.standardRoute,
        standardEnabled: true,
        minStandardProbability: config.router.minStandardProbability,
      },
      primaryClasses: config.router.primaryClasses,
      cheapContextTokens: 100_000,
      classifierTimeoutMs: 1_000,
      classifierMaxChars: 4_000,
    });
    proxy = buildServer({
      config,
      router,
      providers: {
        primary: new AnthropicProvider(config.primary),
        cheap: new OpenAICompatibleProvider(config.cheap),
        standard: new OpenAICompatibleProvider({ ...config.cheap, model: config.cheapStandard!.model }),
      },
    });
    await proxy.listen({ host: '127.0.0.1', port: 0 });
    proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await proxy.close();
    anthropic.close();
    cheap.close();
  });

  const send = (session: string, text: string) =>
    request(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: text }] }),
    });

  it('serves level-2 work from the standard model, and simple work from the trivial one', async () => {
    next = STANDARD;
    const standard = await send('S-std', 'add pagination to the list');
    await standard.body.text();
    assert.equal(standard.statusCode, 200);
    assert.equal(standard.headers['x-jev-route'], 'cheap; reason=classified');
    assert.equal(cheapModels.at(-1), 'gemma4:31b-cloud');

    next = SIMPLE;
    const trivial = await send('S-triv', 'fix the typo');
    await trivial.body.text();
    assert.equal(cheapModels.at(-1), 'gpt-oss:20b-cloud');
  });
});
