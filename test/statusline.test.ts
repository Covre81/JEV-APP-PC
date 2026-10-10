import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { readSessionId, statusLine } from '../src/statusline.js';
import { openTelemetryDb } from '../src/telemetry/db.js';
import { SqliteTelemetry } from '../src/telemetry/recorder.js';
import type { NewRouterLog } from '../src/telemetry/schema.js';
import { renderStatusLine } from '../src/telemetry/statusline.js';

const row = (over: Partial<NewRouterLog>): NewRouterLog => ({
  createdAt: new Date(),
  sessionId: 'sess-1:main',
  finalProvider: 'anthropic',
  routeReason: 'classified',
  outcome: 'ok',
  httpStatus: 200,
  latencyMs: 100,
  ...over,
});
/** What audit.ts writes for a main-agent request that carries typed human text. */
const turn = { requestClass: 'main', humanPromptHash: 'h' } as const;
const jev = (pSimple: number) => ({ simple: pSimple, standard: 0, structural: 1 - pSimple, pSimple, pComplex: 0, classifierMs: 50 });

describe('statusline', () => {
  let health: Server;
  let healthUrl: string;
  let dbPath: string;

  before(async () => {
    health = createServer((req, res) => void res.writeHead(req.url === '/healthz' ? 200 : 404).end('{"ok":true}'));
    await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
    healthUrl = `http://127.0.0.1:${(health.address() as AddressInfo).port}/healthz`;

    dbPath = join(mkdtempSync(join(tmpdir(), 'jev-statusline-')), 'telemetry.db');
    const sink = new SqliteTelemetry(openTelemetryDb(dbPath), { flushIntervalMs: 60_000 });
    // Today's share counts main-agent human turns plus any JEV decision: 7 below, 3 answered by the cheap model.
    sink.record(row({ ...turn, finalProvider: 'openai', jevDecision: jev(0.93) }));
    sink.record(row({ sessionId: 'sess-1:agent-2', routeReason: 'sticky', requestClass: 'subagent', humanPromptHash: 'h' }));
    sink.record(row({ ...turn, sessionId: 'sess-10:main', finalProvider: 'openai', jevDecision: jev(0.97) }));
    sink.record(row({ ...turn, sessionId: 'old:main', createdAt: new Date('2020-01-01T00:00:00Z') }));
    sink.record(row({ ...turn, sessionId: 'big:main', routeReason: 'sticky', tokensIn: 180_000 }));
    sink.record(row({ sessionId: 'big:main', routeReason: 'sticky', requestClass: 'main', tokensIn: 412_300 })); // tool-result continuation
    sink.record(row({ sessionId: 'big:main', routeReason: 'sticky', requestClass: 'main', outcome: 'stream_error' })); // no usage: must not hide the warning
    sink.record(row({ sessionId: 'big:agent-1', routeReason: 'sticky', tokensIn: 30_000 }));
    sink.record(row({ ...turn, sessionId: 'small:main', routeReason: 'sticky', tokensIn: 64_400 }));
    sink.record(row({ sessionId: 'sub:agent-1', requestClass: 'subagent', humanPromptHash: 'h', finalProvider: 'openai', jevDecision: jev(0.92) }));
    sink.record(row({ sessionId: 'nohdr:main', humanPromptHash: 'h', jevDecision: jev(0.4) })); // no hint headers: request class is null
    sink.record(row({ sessionId: 'aux:main', routeReason: 'passthrough:request-class', requestClass: 'auxiliary', humanPromptHash: 'h' }));
    sink.record(row({ ...turn, sessionId: 'fail:main', finalProvider: 'openai', outcome: 'stream_error', jevDecision: jev(0.95) }));
    // No human text, no JEV decision: outside today's share.
    sink.record(row({ sessionId: 'swap:main', finalProvider: 'openai', routeReason: 'sticky', model: 'gpt-oss:20b-cloud', requestedModel: 'claude-opus-5-5' }));
    sink.record(row({ sessionId: 'same:main', routeReason: 'sticky', model: 'claude-opus-5-5', requestedModel: 'claude-opus-5-5' }));
    await sink.close();
  });
  after(() => new Promise<void>((r) => health.close(() => r())));

  it('names the served model only when it differs from the requested one', async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'swap' }), 'jev-router ✓ · last: cheap gpt-oss:20b-cloud (sticky) · today 3/7 cheap');
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'same' }), 'jev-router ✓ · last: claude (sticky) · today 3/7 cheap');
  });

  it("shows the session's last route, across its agents, and today's cheap share of routed turns", async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'sess-1' }), 'jev-router ✓ · last: claude (sticky) · today 3/7 cheap');
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'sess-10' }), 'jev-router ✓ · last: cheap (JEV 0.97) · today 3/7 cheap');
  });

  it('says only that the router is up when the session has no turns yet', async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'new' }), 'jev-router ✓ · today 3/7 cheap');
    assert.equal(await statusLine({ dbPath: join(tmpdir(), 'missing-jev.db'), healthUrl }), 'jev-router ✓');
  });

  it('drops the details instead of failing when the database is unreadable', async () => {
    const garbage = join(mkdtempSync(join(tmpdir(), 'jev-statusline-')), 'telemetry.db');
    writeFileSync(garbage, 'not a sqlite database, just bytes '.repeat(200));
    assert.equal(await statusLine({ dbPath: garbage, healthUrl, sessionId: 'sess-1' }), 'jev-router ✓');
  });

  it("shows the main agent's latest context and warns past 200k", async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'small' }), 'jev-router ✓ · last: claude (sticky) · ctx 64k · today 3/7 cheap');
    assert.equal(
      await statusLine({ dbPath, healthUrl, sessionId: 'big' }),
      'jev-router ✓ · last: claude (sticky) · ⚠ ctx 412k → /compact or /clear · today 3/7 cheap',
    );
  });

  it('reports the router offline when /healthz does not answer', async () => {
    assert.equal(await statusLine({ dbPath, healthUrl: 'http://127.0.0.1:1/healthz', sessionId: 'sess-1' }), 'jev-router ✗ offline');
  });

  // The timeout turns a missing health timeout into a failure instead of a hung suite.
  it('reports the router offline when /healthz accepts but never answers', { timeout: 2_000 }, async () => {
    const hung = createServer(() => {});
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/healthz`;
      assert.equal(await statusLine({ dbPath, healthUrl: url, sessionId: 'sess-1' }), 'jev-router ✗ offline');
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((r) => hung.close(() => r()));
    }
  });

  it('warns when the running router is older than the build on disk, and when cheap is down', async () => {
    const running = { sha: 'aaaaaaaaaaaa', builtAt: '2026-10-07T10:00:00.000Z' };
    const router = createServer((_req, res) =>
      void res.writeHead(200).end(JSON.stringify({ ok: true, ...running, cheap: 'down' })),
    );
    await new Promise<void>((r) => router.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(router.address() as AddressInfo).port}/healthz`;
      const missing = join(tmpdir(), 'missing-jev.db');
      assert.equal(
        await statusLine({ dbPath: missing, healthUrl: url, localBuild: { ...running, sha: 'bbbbbbbbbbbb' } }),
        'jev-router ✓ · ⚠ build velho · cheap ✗',
      );
      assert.equal(await statusLine({ dbPath: missing, healthUrl: url, localBuild: running }), 'jev-router ✓ · cheap ✗');
    } finally {
      router.closeAllConnections();
      await new Promise<void>((r) => router.close(() => r()));
    }
  });

  it('leaves the quota echo out unless asked for (STATUSLINE_QUOTA=1)', async () => {
    const quotaDb = join(mkdtempSync(join(tmpdir(), 'jev-statusline-quota-')), 'telemetry.db');
    const db = openTelemetryDb(quotaDb);
    db.prepare('INSERT INTO quota_observations (created_at, utilization, window, status) VALUES (?, ?, ?, ?)').run(Date.now(), 0.42, '5h', 'allowed');
    db.close();
    assert.equal(await statusLine({ dbPath: quotaDb, healthUrl }), 'jev-router ✓');
    assert.equal(await statusLine({ dbPath: quotaDb, healthUrl, showQuota: true }), 'jev-router ✓ · cota 42% 5h');
  });

  it('shows the binding Claude quota window, with a warning from 80% on', () => {
    assert.equal(renderStatusLine({ healthy: true, quota: { utilization: 0.42, window: '5h' } }), 'jev-router ✓ · cota 42% 5h');
    assert.equal(renderStatusLine({ healthy: true, quota: { utilization: 0.82, window: '5h' } }), 'jev-router ✓ · ⚠ cota 82% 5h');
  });

  it('flags a last turn that did not end ok', () => {
    assert.equal(
      renderStatusLine({ healthy: true, last: { provider: 'openai', reason: 'classified', outcome: 'stream_error', pSimple: 0.9 } }),
      'jev-router ✓ · last: cheap (JEV 0.90) stream_error',
    );
  });

  it('names the served model when the router swapped it', () => {
    assert.equal(
      renderStatusLine({ healthy: true, last: { provider: 'openai', reason: 'classified', outcome: 'ok', pSimple: 0.95, model: 'gpt-oss:20b-cloud' } }),
      'jev-router ✓ · last: cheap gpt-oss:20b-cloud (JEV 0.95)',
    );
  });

  it('warns from exactly 200k context on', () => {
    assert.equal(renderStatusLine({ healthy: true, context: 199_999 }), 'jev-router ✓ · ctx 200k');
    assert.equal(renderStatusLine({ healthy: true, context: 200_000 }), 'jev-router ✓ · ⚠ ctx 200k → /compact or /clear');
  });

  it('reads the session id from the JSON Claude Code pipes in, and gives up on silence', async () => {
    const piped = new PassThrough();
    piped.end(JSON.stringify({ session_id: 'abc', model: { id: 'x' } }));
    assert.equal(await readSessionId(piped as unknown as NodeJS.ReadStream), 'abc');
    assert.equal(await readSessionId(new PassThrough() as unknown as NodeJS.ReadStream), undefined);
  });
});
