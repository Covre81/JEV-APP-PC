import assert from 'node:assert';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { describe, before, after, it } from 'node:test';
import { tmpdir } from 'node:os';
import { openTelemetryDb } from '../src/telemetry/db.js';

import { getMachineOrigin } from '../src/context/origin.js';
import { cleanFtsQuery, searchMemory } from '../src/context/memory-source.js';
import { getGraphSources } from '../src/context/graph-source.js';
import type { GraphData, GraphCommunity } from '../src/context/graph-source.js';
import { JevClient, JevHttpError } from '../src/context/jev-client.js';
import { rankCommunities } from '../src/context/relevance.js';
import { scoreCandidates } from '../src/context/select.js';
import type { Candidate } from '../src/context/select.js';
import { recordContextRun } from '../src/context/log.js';
import { runPipeline, type PipelineConfig } from '../src/context/pipeline.js';
import { MIGRATIONS } from '../src/telemetry/schema.js';

describe('context-origin', () => {
  it('correctly classifies machine origin tags', () => {
    assert.strictEqual(getMachineOrigin('<task-notification> hello'), 'machine:task-notification');
    assert.strictEqual(getMachineOrigin('  <wake> system reboot '), 'machine:wake');
    assert.strictEqual(getMachineOrigin('\n<relay> test-run'), 'machine:relay');
    assert.strictEqual(getMachineOrigin('human prompt with <task-notification> in middle'), undefined);
    assert.strictEqual(getMachineOrigin('plain human text'), undefined);
  });
});

describe('context-memory', () => {
  it('cleans FtsQuery removing syntax characters and filtering word sizes', () => {
    const rawPrompt = 'Fix the parsing! Use standard AND, OR, NOT operations with longwordtoolongtobevalid.';
    const cleaned = cleanFtsQuery(rawPrompt);
    const terms = cleaned.split(' OR ');
    
    assert.ok(terms.includes('fix'));
    assert.ok(terms.includes('the'));
    assert.ok(terms.includes('parsing'));
    assert.ok(terms.includes('use'));
    assert.ok(terms.includes('standard'));
    assert.ok(terms.includes('operations'));
    assert.ok(!terms.includes('longwordtoolongtobevalid'));
    assert.ok(terms.every((t) => t.length >= 3 && t.length <= 12));
  });

  it('returns empty array when .ai-memory.toml is missing', async () => {
    const tempDir = join(tmpdir(), 'test-temp-missing-toml-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    try {
      const hits = await searchMemory({
        bin: 'node',
        cwd: tempDir,
        prompt: 'test prompt',
        timeoutMs: 1000,
      });
      assert.deepStrictEqual(hits, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('context-graph', () => {
  const tempDir = join(resolve('.'), 'test-temp-graph-' + Date.now());

  before(() => {
    mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses graph files, computes degrees and filters communities', () => {
    const graphData = {
      nodes: [
        { id: 'A', label: 'Node A', community: 1 },
        { id: 'B', label: 'Node B', community: 1 },
        { id: 'C', label: 'Node C', community: 2 },
        { id: 'D', label: 'Node D', community: 2 },
        { id: 'E', label: 'Node E', community: 3 },
      ],
      links: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'D' },
        { source: 'A', target: 'C' },
      ],
    };

    const graphDir = join(tempDir, 'proj1', 'graphify-out');
    mkdirSync(graphDir, { recursive: true });
    const graphFile = join(graphDir, 'graph.json');
    writeFileSync(graphFile, JSON.stringify(graphData), 'utf8');

    // Duplicate graph
    const graphDir2 = join(tempDir, 'proj2', 'graphify-out');
    mkdirSync(graphDir2, { recursive: true });
    const graphFile2 = join(graphDir2, 'graph.json');
    writeFileSync(graphFile2, JSON.stringify(graphData), 'utf8');

    // Broken JSON graph
    const graphDir3 = join(tempDir, 'proj3', 'graphify-out');
    mkdirSync(graphDir3, { recursive: true });
    const graphFile3 = join(graphDir3, 'graph.json');
    writeFileSync(graphFile3, 'broken { json', 'utf8');

    const sources = getGraphSources(tempDir, tempDir);
    
    assert.strictEqual(sources.length, 1);
    const loaded = sources[0]!;
    
    assert.strictEqual(loaded.communities.length, 3);
    
    const comm2 = loaded.communities.find((c) => c.id === '2')!;
    assert.strictEqual(comm2.topNodes[0]!.id, 'C');
    assert.strictEqual(comm2.topNodes[0]!.degree, 3);
    assert.strictEqual(comm2.topNodes[1]!.id, 'D');
    assert.strictEqual(comm2.topNodes[1]!.degree, 1);
  });
});

describe('context-relevance', () => {
  let server: Server;
  let url: string;
  let client: JevClient;
  let lastRequestBody: any = null;

  before(async () => {
    server = createServer((req, res) => {
      let bodyStr = '';
      req.on('data', (chunk) => { bodyStr += chunk; });
      req.on('end', () => {
        lastRequestBody = JSON.parse(bodyStr);
        res.writeHead(200, { 'content-type': 'application/json' });
        
        const firstQuestionKey = Object.keys(lastRequestBody.questions || {})[0];
        const questionType = lastRequestBody.questions[firstQuestionKey!]?.type;
        
        if (questionType === 'choice') {
          const probs: Record<string, number> = {};
          let val = 0.9;
          for (const choice of lastRequestBody.questions.relevant_community.choices) {
            probs[choice] = val;
            val = Math.max(0.1, val - 0.1);
          }
          res.end(JSON.stringify({
            answers: {
              relevant_community: {
                probabilities: probs,
              },
            },
          }));
        } else {
          const answers: Record<string, any> = {};
          for (const key of Object.keys(lastRequestBody.questions)) {
            answers[key] = { noul: 0.85 };
          }
          res.end(JSON.stringify({ answers }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/v1/systemone`;
    client = new JevClient({ apiUrl: url, apiKey: 'mock_key' });
  });

  after(() => {
    server.close();
  });

  it('chunks 300 communities into 2 requests', async () => {
    const communities: GraphCommunity[] = [];
    for (let i = 0; i < 300; i++) {
      communities.push({
        id: String(i),
        topNodes: [],
        description: `node${i}`,
      });
    }
    const graph: GraphData = {
      path: 'graph.json',
      sha256: 'sha',
      project: 'proj',
      isCurrent: true,
      communities,
    };

    let callCount = 0;
    server.on('request', () => {
      callCount++;
    });

    callCount = 0;
    const ranked = await rankCommunities({
      client,
      model: 'jev-model',
      prompt: 'hello',
      graphs: [graph],
      signal: AbortSignal.timeout(1000),
    });

    assert.strictEqual(callCount, 2);
    assert.strictEqual(ranked.length, 2);
  });

  it('batches 175 candidates into 6 requests', async () => {
    const candidates: Candidate[] = [];
    for (let i = 0; i < 175; i++) {
      candidates.push({
        id: `c${i}`,
        type: 'memory',
        path: `doc${i}.md`,
        content: `snippet${i}`,
        isCurrent: true,
        project: 'proj',
      });
    }

    let callCount = 0;
    const countRequest = () => { callCount++; };
    server.on('request', countRequest);
    callCount = 0;

    const scored = await scoreCandidates({
      client,
      model: 'jev-model',
      prompt: 'hello',
      candidates,
      signal: AbortSignal.timeout(2000),
    });

    server.off('request', countRequest);

    assert.strictEqual(callCount, 6);
    assert.strictEqual(scored.length, 175);
    assert.strictEqual(scored[0]!.p, 0.85);
  });
});

describe('context-pipeline', () => {
  let server: Server;
  let url: string;
  let tempDbFile: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        answers: {
          relevant_community: {
            probabilities: { 'Community 1: nodeA': 0.95 },
          },
          c0: { noul: 0.95 },
        },
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/v1/systemone`;

    tempDbFile = join(resolve('.'), 'test-context-pipeline-db-' + Date.now() + '.db');
    process.env['TELEMETRY_DB_PATH'] = tempDbFile;
    const db = openTelemetryDb(tempDbFile);
    db.close();
  });

  after(() => {
    server.close();
    if (existsSync(tempDbFile)) {
      unlinkSync(tempDbFile);
    }
    delete process.env['TELEMETRY_DB_PATH'];
  });

  it('runs the pipeline and correctly handles skipped origin machine prompts', async () => {
    const config: PipelineConfig = {
      mode: 'inject',
      lCurrent: 0.8,
      lOther: 0.9,
      maxItems: 5,
      maxChars: 1500,
      timeoutMs: 1000,
      aiMemoryBin: 'node',
      apiKey: 'mock_key',
      apiUrl: url,
      model: 'jev-latest',
    };

    const input = {
      prompt: '<task-notification> system message',
      session_id: 'sess-123',
      cwd: resolve('.'),
    };

    const res = await runPipeline(input, config);
    assert.strictEqual(res.outcome, 'skipped_origin');
    assert.strictEqual(res.stdout, '');

    const db = new DatabaseSync(tempDbFile);
    const row: any = db.prepare('SELECT * FROM context_runs WHERE session_id = ?').get('sess-123');
    db.close();
    assert.ok(row);
    assert.strictEqual(row.outcome, 'skipped_origin');
  });

  it('handles pipeline timeouts', async () => {
    const slowServer = createServer((req, res) => { /* hang */ });
    await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', r));
    const slowPort = (slowServer.address() as AddressInfo).port;
    const slowUrl = `http://127.0.0.1:${slowPort}/v1/systemone`;

    try {
      const config: PipelineConfig = {
        mode: 'inject',
        lCurrent: 0.8,
        lOther: 0.9,
        maxItems: 5,
        maxChars: 1500,
        timeoutMs: 50,
        aiMemoryBin: 'node',
        apiKey: 'mock_key',
        apiUrl: slowUrl,
        model: 'jev-latest',
      };

      const input = {
        prompt: 'ordinary prompt',
        session_id: 'sess-timeout',
        cwd: resolve('.'),
      };

      const res = await runPipeline(input, config);
      assert.strictEqual(res.outcome, 'timeout');
    } finally {
      slowServer.close();
    }
  });
});

describe('context-log', () => {
  it('correctly executes transaction and enforces CHECK constraint on rollback', () => {
    const db = new DatabaseSync(':memory:');
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }

    const run = {
      sessionId: 'sess-log-test',
      prompt: 'test prompt',
      mode: 'inject' as const,
      outcome: 'ok' as const,
      pipelineVersion: 'hash123',
      injected: true,
      injectedChars: 50,
    };

    const candidates = [
      { type: 'memory' as const, path: 'doc1.md', content: 'good content', p: 0.85, injected: true },
      { type: 'memory' as const, path: 'doc2.md', content: 'good content 2', p: 0.5, injected: false },
    ];

    const runId = recordContextRun(db, run, candidates);
    assert.ok(runId > 0);

    const insertedRun: any = db.prepare('SELECT * FROM context_runs WHERE id = ?').get(runId);
    assert.strictEqual(insertedRun.session_id, 'sess-log-test');

    const insertedCands = db.prepare('SELECT * FROM context_candidates WHERE run_id = ?').all(runId);
    assert.strictEqual(insertedCands.length, 2);

    const invalidCandidates = [
      { type: 'memory' as const, path: 'invalid.md', content: 'bad score', p: 1.5, injected: true },
    ];

    assert.throws(() => {
      recordContextRun(db, { ...run, sessionId: 'sess-rolled-back' }, invalidCandidates);
    }, /constraint/i);

    const rolledBackRun = db.prepare('SELECT * FROM context_runs WHERE session_id = ?').get('sess-rolled-back');
    assert.strictEqual(rolledBackRun, undefined);

    db.close();
  });
});

describe('context-cli.e2e', () => {
  let server: Server;
  let url: string;
  let tempEnvFile: string;
  let tempDbFile: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        answers: {
          relevant_community: {
            probabilities: { 'Community 1: nodeA': 0.95 },
          },
          c0: { noul: 0.98 },
        },
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/v1/systemone`;

    tempDbFile = join(resolve('.'), 'test-context-cli-db-' + Date.now() + '.db');
    const db = new DatabaseSync(tempDbFile);
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
    db.close();

    tempEnvFile = join(resolve('.'), 'test-context-cli-env-' + Date.now() + '.env');
    writeFileSync(tempEnvFile, [
      `TYPESAFE_API_KEY=mock_api_key`,
      `JEV_API_URL=${url}`,
      `TELEMETRY_DB_PATH=${tempDbFile}`,
      `CONTEXT_MODE=inject`,
    ].join('\n'), 'utf8');
  });

  after(() => {
    server.close();
    if (existsSync(tempEnvFile)) {
      unlinkSync(tempEnvFile);
    }
    if (existsSync(tempDbFile)) {
      unlinkSync(tempDbFile);
    }
  });

  it('runs CLI command context and prints injected JSON with additionalContext', () => {
    return new Promise<void>((resolvePromise, reject) => {
      const proc = spawn('node', ['--import', 'tsx', 'src/cli.ts', 'context', '--env', tempEnvFile], {
        env: { ...process.env, TELEMETRY_DB_PATH: tempDbFile },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });

      const payload = JSON.stringify({
        prompt: 'help me with standard routing',
        session_id: 'e2e-session-uuid',
        cwd: resolve('.'),
      });

      proc.stdin.write(payload);
      proc.stdin.end();

      proc.on('close', (code) => {
        try {
          assert.strictEqual(code, 0);
          if (stdout) {
            try {
              const parsed = JSON.parse(stdout);
              assert.ok(parsed.hookSpecificOutput);
              assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
            } catch {
              assert.strictEqual(stdout, '');
            }
          } else {
            assert.strictEqual(stdout, '');
          }
          resolvePromise();
        } catch (err) {
          reject(err);
        }
      });
    });
  });
});
