import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { inTransaction, openTelemetryDb, userVersion } from '../src/telemetry/db.js';
import { SqliteTelemetry } from '../src/telemetry/recorder.js';
import { MIGRATIONS, type NewRouterLog } from '../src/telemetry/schema.js';
import { computeStats, parseSince, renderStats } from '../src/telemetry/stats.js';

const row = (over: Partial<NewRouterLog>): NewRouterLog => ({
  createdAt: new Date('2026-10-01T12:00:00Z'),
  sessionId: 's:main',
  finalProvider: 'anthropic',
  routeReason: 'classified',
  outcome: 'ok',
  httpStatus: 200,
  latencyMs: 100,
  ...over,
});

describe('telemetry → stats', () => {
  it('aggregates diversion, fallbacks, repeats and estimated savings', async () => {
    const db = openTelemetryDb(':memory:');
    const sink = new SqliteTelemetry(db, { flushIntervalMs: 60_000 });
    const jev = { simple: 0.9, standard: 0.07, structural: 0.03, pSimple: 0.9, pComplex: 0.03, classifierMs: 80 };

    sink.record(row({ finalProvider: 'openai', jevDecision: jev, humanPromptHash: 'h1', tokensIn: 1000, tokensOut: 200 }));
    sink.record(row({ finalProvider: 'openai', humanPromptHash: 'h1', tokensIn: 500, tokensOut: 50 }));
    sink.record(row({ finalProvider: 'openai', outcome: 'stream_error', tokensIn: 999, tokensOut: 9 }));
    sink.record(row({ routeReason: 'failover:cheap-unavailable', fallbackTriggered: true, tokensIn: 3000, tokensOut: 100, cacheReadTokens: 2000 }));
    sink.record(row({ createdAt: new Date('2026-09-01T00:00:00Z'), tokensIn: 7, tokensOut: 7 }));
    sink.flush();

    const all = computeStats(db);
    assert.equal(all.total, 5);
    assert.equal(all.byProvider.openai.requests, 3);
    assert.equal(all.byProvider.openai.ok, 2);
    assert.equal(all.byProvider.anthropic.cacheReadTokens, 2000);
    assert.equal(all.fallbacks, 1);
    assert.equal(all.cheapStreamErrors, 1);
    assert.equal(all.classified, 1);
    assert.equal(all.repeatedPrompts, 1);
    assert.equal(all.repeatedSends, 1);
    assert.equal(all.estimatedTokensSaved, 1750, 'only cheap requests served OK count');

    const recent = computeStats(db, { since: new Date('2026-09-15T00:00:00Z') });
    assert.equal(recent.total, 4);

    const text = renderStats(all);
    assert.match(text, /Requests\s+5/);
    assert.match(text, /Estimated Anthropic tokens saved\s+1,750/);
    assert.match(text, /NET \((PROFIT|LOSS)\)/);
    assert.match(text, /Cheap provider priced at \$0/);
    await sink.close();
  });

  it('keeps rows queued when a write fails and retries on the next flush', async () => {
    const db = openTelemetryDb(':memory:');
    const errors: unknown[] = [];
    const sink = new SqliteTelemetry(db, { flushIntervalMs: 60_000, onError: (e) => errors.push(e) });
    db.exec('ALTER TABLE router_logs RENAME TO router_logs_tmp');
    sink.record(row({}));
    sink.flush();
    assert.equal(errors.length, 1);
    db.exec('ALTER TABLE router_logs_tmp RENAME TO router_logs');
    sink.flush();
    assert.equal(computeStats(db).total, 1);
    await sink.close();
  });

  it('rolls back a failed batch so no row is written twice', () => {
    const db = openTelemetryDb(':memory:');
    const insert = `INSERT INTO router_logs (final_provider, route_reason, outcome, latency_ms) VALUES ('openai', 'classified', 'ok', 5)`;
    assert.throws(() =>
      inTransaction(db, () => {
        db.exec(insert);
        throw new Error('disk full');
      }),
    );
    assert.equal(computeStats(db).total, 0);
    inTransaction(db, () => db.exec(insert));
    assert.equal(computeStats(db).total, 1);
    db.close();
  });

  it('upgrades a database migrated by drizzle without re-running its migrations', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jev-telemetry-')), 'telemetry.db');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]!);
    old.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    old.exec(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('f8bc9d56', 1791066394899)`);
    old.exec(`INSERT INTO router_logs (final_provider, route_reason, outcome, latency_ms) VALUES ('openai', 'classified', 'ok', 5)`);
    old.close();

    const db = openTelemetryDb(path);
    assert.equal(userVersion(db), MIGRATIONS.length);
    const columns = (db.prepare('PRAGMA table_info(router_logs)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes('requested_model') && columns.includes('cache_write_tokens'));
    assert.equal(computeStats(db).total, 1, 'existing rows survive');
    db.close();

    const reopened = openTelemetryDb(path);
    assert.equal(computeStats(reopened).total, 1, 'reopening applies nothing twice');
    reopened.close();
  });

  it('parses --since spans', () => {
    const now = Date.parse('2026-10-03T00:00:00Z');
    assert.equal(parseSince('24h', now).toISOString(), '2026-10-02T00:00:00.000Z');
    assert.equal(parseSince('7d', now).toISOString(), '2026-09-26T00:00:00.000Z');
    assert.throws(() => parseSince('1w', now));
  });
});
