import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { JevClassifier, jevContractIssues } from '../src/classifier/jev-classifier.js';

const input = { text: 'rename foo to bar', turnCount: 1, toolCount: 20, estimatedInputTokens: 30_000 };

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

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
                  task_complexity: {
                    type: 'score',
                    score: 0.35,
                    legend: { '0': 'a', '1': 'b', '2': 'c' },
                    probabilities: { '0': 0.6, '1': 0.3, '2': 0.1 },
                    confidence: 0.9,
                  },
                },
                usage: { input_tokens: 453, output_tokens: 20 },
              }
            : { error: { message: 'bad key' } },
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  });
  after(() => server.close());

  it('sends one typed score question and returns the distribution', async () => {
    const jev = new JevClassifier({ apiUrl: url, apiKey: 'ts_test', model: 'jev-latest' });
    const scores = await jev.classify(input, AbortSignal.timeout(1_000));

    assert.equal(scores.simple.toFixed(2), '0.60');
    assert.equal(scores.structural.toFixed(2), '0.10');
    assert.equal(lastRequest?.headers.authorization, 'Bearer ts_test');
    assert.equal(lastRequest?.body.model, 'jev-latest');
    assert.match(lastRequest?.body.state, /rename foo to bar/);
    assert.equal(lastRequest?.body.questions.task_complexity.type, 'score');
    assert.equal(lastRequest?.body.questions.task_complexity.criteria.length, 3);
  });

  it('reports the JEV token usage so the classification can be priced', async () => {
    const jev = new JevClassifier({ apiUrl: url, apiKey: 'ts_test', model: 'jev-latest' });
    const scores = await jev.classify(input, AbortSignal.timeout(1_000));
    assert.deepEqual(scores.usage, { inputTokens: 453, outputTokens: 20 });
  });

  it('rejects on non-200 so the router can fail open', async () => {
    status = 401;
    const jev = new JevClassifier({ apiUrl: url, apiKey: 'bad', model: 'jev-latest' });
    await assert.rejects(jev.classify(input, AbortSignal.timeout(1_000)), /JEV HTTP 401/);
    status = 200;
  });
});

describe('jevContractIssues', () => {
  const answer = (probabilities: unknown) => ({ answers: { task_complexity: { probabilities } } });

  it('accepts three levels that sum to 1', () => {
    assert.deepEqual(jevContractIssues(answer({ '0': 0.6, '1': 0.3, '2': 0.1 })), []);
  });

  it('flags what the production parser would silently tolerate', () => {
    const issues = jevContractIssues(answer({ '0': 0.9, '3': 0.05 }));
    assert.ok(issues.some((i) => i.includes('level "1" missing')));
    assert.ok(issues.some((i) => i.includes('level "2" missing')));
    assert.ok(issues.some((i) => i.includes('unexpected levels ["3"]')));
    assert.ok(issues.some((i) => i.includes('sum is 0.9500')));
  });

  it('reports schema breaks with their path', () => {
    const issues = jevContractIssues({ answers: { task_complexity: { probabilities: { '0': 'high' } } } });
    assert.match(issues[0] ?? '', /^schema: answers\.task_complexity\.probabilities\.0:/);
  });
});
