import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
    sink.record(row({ finalProvider: 'openai', jevDecision: jev(0.93) }));
    sink.record(row({ sessionId: 'sess-1:agent-2', routeReason: 'sticky' }));
    sink.record(row({ sessionId: 'sess-10:main', finalProvider: 'openai', jevDecision: jev(0.97) }));
    sink.record(row({ sessionId: 'old:main', createdAt: new Date('2020-01-01T00:00:00Z') }));
    sink.record(row({ sessionId: 'big:main', routeReason: 'sticky', tokensIn: 180_000 }));
    sink.record(row({ sessionId: 'big:main', routeReason: 'sticky', tokensIn: 412_300 }));
    sink.record(row({ sessionId: 'big:agent-1', routeReason: 'sticky', tokensIn: 30_000 }));
    sink.record(row({ sessionId: 'small:main', routeReason: 'sticky', tokensIn: 64_400 }));
    await sink.close();
  });
  after(() => new Promise<void>((r) => health.close(() => r())));

  it("shows the session's last route, across its agents, and today's cheap share", async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'sess-1' }), 'jev-router ✓ · last: claude (sticky) · today 2/7 cheap');
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'sess-10' }), 'jev-router ✓ · last: cheap (JEV 0.97) · today 2/7 cheap');
  });

  it('says only that the router is up when the session has no turns yet', async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'new' }), 'jev-router ✓ · today 2/7 cheap');
    assert.equal(await statusLine({ dbPath: join(tmpdir(), 'missing-jev.db'), healthUrl }), 'jev-router ✓');
  });

  it("shows the main agent's latest context and warns past 200k", async () => {
    assert.equal(await statusLine({ dbPath, healthUrl, sessionId: 'small' }), 'jev-router ✓ · last: claude (sticky) · ctx 64k · today 2/7 cheap');
    assert.equal(
      await statusLine({ dbPath, healthUrl, sessionId: 'big' }),
      'jev-router ✓ · last: claude (sticky) · ⚠ ctx 412k → /compact or /clear · today 2/7 cheap',
    );
  });

  it('reports the router offline when /healthz does not answer', async () => {
    assert.equal(await statusLine({ dbPath, healthUrl: 'http://127.0.0.1:1/healthz', sessionId: 'sess-1' }), 'jev-router ✗ offline');
  });

  it('flags a last turn that did not end ok', () => {
    assert.equal(
      renderStatusLine({ healthy: true, last: { provider: 'openai', reason: 'classified', outcome: 'stream_error', pSimple: 0.9 } }),
      'jev-router ✓ · last: cheap (JEV 0.90) stream_error',
    );
  });

  it('reads the session id from the JSON Claude Code pipes in, and gives up on silence', async () => {
    const piped = new PassThrough();
    piped.end(JSON.stringify({ session_id: 'abc', model: { id: 'x' } }));
    assert.equal(await readSessionId(piped as unknown as NodeJS.ReadStream), 'abc');
    assert.equal(await readSessionId(new PassThrough() as unknown as NodeJS.ReadStream), undefined);
  });
});
