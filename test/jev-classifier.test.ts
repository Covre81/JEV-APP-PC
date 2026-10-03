import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { JevClassifier, scoresFromDistribution } from '../src/classifier/jev-classifier.js';

const input = { text: 'rename foo to bar', turnCount: 1, toolCount: 20, estimatedInputTokens: 30_000 };

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('scoresFromDistribution', () => {
  it('turns the ordinal distribution into cumulative sufficiency', () => {
    assert.deepEqual(scoresFromDistribution({ '0': 0.7, '1': 0.25, '2': 0.05 }), { haiku: 70, sonnet: 95, opus: 100 });
  });
});

describe('JevClassifier', () => {
  let server: Server;
  let url: string;
  let lastRequest: { headers: IncomingMessage['headers']; body: any } | undefined;
  let status = 200;

  before(async () => {
    server = createServer(async (req, res) => {
      lastRequest = { headers: req.headers, body: await readJson(req) };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          status === 200
            ? {
                model: 'jev-1.13.0',
                answers: {
                  required_tier: {
                    type: 'score',
                    score: 0.35,
                    legend: { '0': 'a', '1': 'b', '2': 'c' },
                    probabilities: { '0': 0.8, '1': 0.15, '2': 0.05 },
                    confidence: 0.9,
                  },
                },
              }
            : { error: { message: 'bad key' } },
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  });
  after(() => server.close());

  it('sends one typed score question and maps the answer', async () => {
    const jev = new JevClassifier({ apiUrl: url, apiKey: 'ts_test', model: 'jev-latest' });
    const scores = await jev.classify(input, AbortSignal.timeout(1_000));

    assert.deepEqual(scores, { haiku: 80, sonnet: 95, opus: 100 });
    assert.equal(lastRequest?.headers.authorization, 'Bearer ts_test');
    assert.equal(lastRequest?.body.model, 'jev-latest');
    assert.match(lastRequest?.body.state, /rename foo to bar/);
    assert.equal(lastRequest?.body.questions.required_tier.type, 'score');
    assert.equal(lastRequest?.body.questions.required_tier.criteria.length, 3);
  });

  it('rejects on non-200 so the router can fail open', async () => {
    status = 401;
    const jev = new JevClassifier({ apiUrl: url, apiKey: 'bad', model: 'jev-latest' });
    await assert.rejects(jev.classify(input, AbortSignal.timeout(1_000)), /JEV HTTP 401/);
    status = 200;
  });
});
