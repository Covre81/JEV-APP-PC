import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { request } from 'undici';
import { HeuristicClassifier } from '../src/classifier/heuristic-classifier.js';
import { loadConfig } from '../src/config.js';
import type { Tier } from '../src/domain/tiers.js';
import { buildServer } from '../src/proxy/server.js';
import { Upstream } from '../src/proxy/upstream.js';
import { Router } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}

describe('proxy end-to-end (fake Anthropic upstream)', () => {
  let upstream: Server;
  let proxy: FastifyInstance;
  let proxyUrl: string;
  let seen: Seen[] = [];
  let rejectHaiku = false;

  before(async () => {
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });

      if (req.method === 'HEAD') return res.writeHead(200).end();
      if (rejectHaiku && body?.model === 'claude-haiku-4-5') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '3' });
      res.write(`event: message_start\ndata: {"model":"${body.model}"}\n\n`);
      await sleep(300);
      res.end(`event: message_stop\ndata: {}\n\n`);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const config = loadConfig({ CLASSIFIER: 'heuristic', ANTHROPIC_UPSTREAM_URL: upstreamUrl, LOG_LEVEL: 'fatal' });
    const router = new Router(new HeuristicClassifier(), new TtlLruStore<Tier>(100, 60_000), {
      threshold: config.router.threshold,
      allowEscalation: true,
      passthroughClasses: config.router.passthroughClasses,
      models: config.router.models,
      classifierTimeoutMs: 1_000,
      classifierMaxChars: 4_000,
    });
    proxy = buildServer({ config, router, upstream: new Upstream(config.upstream) });
    await proxy.listen({ host: '127.0.0.1', port: 0 });
    proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await proxy.close();
    upstream.close();
  });

  beforeEach(() => {
    seen = [];
    rejectHaiku = false;
  });

  const claudeCodeRequest = (sessionId: string, text: string) =>
    request(`${proxyUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-client',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14,some-future-beta',
        'x-claude-code-session-id': sessionId,
        'x-claude-code-request-class': 'main',
      },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 64_000,
        stream: true,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system: [{ type: 'text', text: 'You are Claude Code' }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      }),
    });

  it('routes a trivial prompt to Haiku, adapts the body, forwards headers verbatim, and streams', async () => {
    const res = await claudeCodeRequest('S-trivial', 'fix the typo in the README');

    let firstChunkAt = 0;
    const parts: string[] = [];
    for await (const chunk of res.body) {
      firstChunkAt ||= Date.now();
      parts.push(chunk.toString());
    }
    const endedAt = Date.now();

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['retry-after'], '3');
    assert.match(String(res.headers['x-jev-route']), /^claude-haiku-4-5; reason=classified/);
    assert.ok(endedAt - firstChunkAt >= 200, 'first SSE event must be relayed before the stream ends');
    assert.match(parts.join(''), /"model":"claude-haiku-4-5"/);

    const [up] = seen;
    assert.equal(up?.url, '/v1/messages?beta=true');
    assert.equal(up?.headers['x-api-key'], 'sk-ant-client');
    assert.equal(up?.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14,some-future-beta');
    assert.equal(up?.body.model, 'claude-haiku-4-5');
    assert.equal(up?.body.thinking, undefined);
    assert.equal(up?.body.output_config, undefined);
    assert.deepEqual(up?.body.system, [{ type: 'text', text: 'You are Claude Code' }]);
  });

  it('forwards an untouched request byte-for-byte on the requested model', async () => {
    const res = await claudeCodeRequest('S-hard', 'redesign the architecture to remove the race condition');
    await res.body.text();
    assert.match(String(res.headers['x-jev-route']), /^claude-opus-5-5/);
    assert.equal(seen[0]?.body.model, 'claude-opus-5-5');
    assert.deepEqual(seen[0]?.body.thinking, { type: 'adaptive' });
  });

  it('replays on the requested model when the routed model is rejected', async () => {
    rejectHaiku = true;
    const res = await claudeCodeRequest('S-reject', 'fix the typo');
    await res.body.text();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      seen.map((s) => s.body.model),
      ['claude-haiku-4-5', 'claude-opus-5-5'],
    );
    assert.match(String(res.headers['x-jev-route']), /reason=fallback:upstream-rejected/);
  });

  it('passes unknown endpoints through untouched', async () => {
    const res = await request(`${proxyUrl}/api/hello`, { method: 'HEAD' });
    await res.body.dump();
    assert.equal(res.statusCode, 200);
    assert.equal(seen[0]?.method, 'HEAD');
    assert.equal(seen[0]?.url, '/api/hello');
  });
});
