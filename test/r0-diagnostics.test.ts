import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';

import { MIGRATIONS } from '../src/telemetry/schema.js';
import { openTelemetryDb } from '../src/telemetry/db.js';
import { rateLimitHeaderNames } from '../src/proxy/server.js';
import { meterAnthropicBody } from '../src/telemetry/usage-meter.js';
import { computeCacheMisses, renderCacheMisses, computeStatsByClass, computeDailyStats, renderDailyStats } from '../src/telemetry/stats.js';
import { pricingFromEnv, anthropicListPrice } from '../src/telemetry/pricing.js';
import { computeNetCost } from '../src/telemetry/cost.js';

const collect = async (r: Readable) => Buffer.concat(await r.toArray());

describe('R0 Diagnostics', () => {
  it('migrates a database without losing rows and adds new columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-migrate-'));
    const file = join(dir, 'telemetry.db');
    const old = new DatabaseSync(file);
    // Run up to migration 5 (0 to 5)
    for (const sql of MIGRATIONS.slice(0, 6)) old.exec(sql);
    old.exec('PRAGMA user_version = 6');
    old.exec(`INSERT INTO router_logs (final_provider, route_reason, outcome, latency_ms) VALUES ('openai', 'classified', 'ok', 5)`);
    old.close();

    const db = openTelemetryDb(file);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.deepEqual(
      { ...db.prepare('SELECT max_tokens, cache_write_5m_tokens, cache_write_1h_tokens FROM router_logs').get() },
      { max_tokens: null, cache_write_5m_tokens: null, cache_write_1h_tokens: null }
    );
    db.close();
  });

  it('rateLimitHeaderNames sorts, filters, and lowercases correctly', () => {
    assert.deepEqual(
      rateLimitHeaderNames({
        'ANTHROPIC-RATELIMIT-B': '1',
        'anthropic-ratelimit-a': '1',
        'content-type': 'text/plain',
        'Anthropic-RateLimit-Requests-Limit': '10'
      }),
      ['ANTHROPIC-RATELIMIT-B', 'Anthropic-RateLimit-Requests-Limit', 'anthropic-ratelimit-a']
    );
    assert.deepEqual(rateLimitHeaderNames({ 'other': '1' }), []);
  });

  it('meterAnthropicBody parses ephemeral 5m/1h cache-write split from JSON body', async () => {
    const body = Buffer.from(JSON.stringify({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation: {
          ephemeral_5m_input_tokens: 15,
          ephemeral_1h_input_tokens: 5
        }
      }
    }));
    const m = meterAnthropicBody(Readable.from([body]), 'application/json', undefined);
    await collect(m.body);
    await m.settled;
    assert.deepEqual(m.usage(), {
      tokensIn: 80,
      tokensOut: 5,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
      cacheWrite5mTokens: 15,
      cacheWrite1hTokens: 5
    } as any); // cast since properties are optional
  });

  it('meterAnthropicBody parses ephemeral 5m/1h cache-write split from SSE body', async () => {
    const sse = Buffer.from(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":50,"cache_creation":{"ephemeral_5m_input_tokens":15,"ephemeral_1h_input_tokens":5}}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\r\n'),
    );
    const m = meterAnthropicBody(Readable.from([sse]), 'text/event-stream', undefined);
    await collect(m.body);
    await m.settled;
    assert.deepEqual(m.usage(), {
      tokensIn: 80,
      tokensOut: 5,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
      cacheWrite5mTokens: 15,
      cacheWrite1hTokens: 5
    } as any);
  });
});

describe('R0 Diagnostics - Stats and Pricing', () => {
  it('identifies every cache-miss cause and computes per-cause summary', () => {
    const db = openTelemetryDb(':memory:');
    const pricing = pricingFromEnv({});
    db.exec(`
      INSERT INTO router_logs (final_provider, route_reason, outcome, latency_ms, tokens_in, cache_write_tokens, created_at, session_id, requested_model, compaction, system_hash, tools_hash) VALUES 
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 1000000, 's1', 'claude-sonnet-5', null, 'sys1', 'tools1'), -- first-row-of-session
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 1001000, 's1', 'claude-sonnet-5', 'compaction:1', 'sys1', 'tools1'), -- compaction
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 1001500, 's2', 'claude-sonnet-5', null, 'sys1', 'tools1'), -- first-row for s2
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 1002000, 's2', 'claude-sonnet-5-5', null, 'sys1', 'tools1'), -- model-switch
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 1003000, 's2', 'claude-sonnet-5-5', null, 'sys2', 'tools1'), -- system-changed
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 1004000, 's2', 'claude-sonnet-5-5', null, 'sys2', 'tools2'), -- tools-changed
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 2004000, 's2', 'claude-sonnet-5-5', null, 'sys2', 'tools2'), -- gap5-60m (1000s)
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 6004000, 's2', 'claude-sonnet-5-5', null, 'sys2', 'tools2'), -- gap>1h (4000s)
      ('anthropic', 'reason', 'ok', 5, 200000, 200000, 6004500, 's2', 'claude-sonnet-5-5', null, 'sys2', 'tools2') -- unknown
    `);

    const stats = computeCacheMisses(db, pricing, { minWrite: 150000 });
    const causes = stats.misses.map((m: any) => m.cause);
    assert.deepEqual(causes, ['first-row-of-session', 'compaction', 'first-row-of-session', 'model-switch', 'system-changed', 'tools-changed', 'gap5-60m', 'gap>1h', 'unknown']);
    
    assert.equal(stats.summary['first-row-of-session']!.count, 2);
    assert.equal(stats.summary['compaction']!.count, 1);
    assert.equal(stats.summary['model-switch']!.count, 1);
    assert.equal(stats.summary['system-changed']!.count, 1);
    assert.equal(stats.summary['tools-changed']!.count, 1);
    assert.equal(stats.summary['gap5-60m']!.count, 1);
    assert.equal(stats.summary['gap>1h']!.count, 1);
    assert.equal(stats.summary['unknown']!.count, 1);

    db.close();
  });

  it('checks for oversized rows per-row entries', () => {
    const db = openTelemetryDb(':memory:');
    const pricing = pricingFromEnv({});
    db.exec(`
      INSERT INTO router_logs (final_provider, route_reason, outcome, latency_ms, tokens_in, cache_read_tokens, cache_write_tokens, created_at) VALUES 
      ('anthropic', 'reason', 'ok', 5, 1000001, 500000, 500001, 1000000)
    `);
    
    const stats = computeCacheMisses(db, pricing, { minWrite: 150000 });
    assert.equal(stats.oversized.length, 1);
    assert.equal(stats.oversized[0].tokensIn, 1000001);
    
    const render = renderCacheMisses(stats);
    assert.ok(render.includes('Oversized rows (tokens_in > 1,000,000): 1\n  id=1, tokens_in=1,000,001, cache_read=500,000, cache_write=500,001, fresh=0'));
    assert.ok(render.includes('\n'), 'uses real newlines');
    assert.ok(!render.includes('\\n'), 'does not use literal backslash-n');
    db.close();
  });

  it('computeStatsByClass pricing only anthropic rows', () => {
    const db = openTelemetryDb(':memory:');
    const pricing = pricingFromEnv({});
    db.exec(`
      INSERT INTO router_logs (final_provider, route_reason, latency_ms, request_class, requested_model, tokens_in, cache_write_tokens, outcome, created_at) VALUES 
      ('anthropic', 'reason', 5, 'edit', 'claude-sonnet-5', 1000000, 1000000, 'ok', 1),
      ('openai', 'reason', 5, 'edit', 'claude-sonnet-5', 1000000, 1000000, 'ok', 2)
    `);
    const stats = computeStatsByClass(db, pricing, {});
    const anthropicStats = stats.find((s: any) => s.finalProvider === 'anthropic')!;
    const openaiStats = stats.find((s: any) => s.finalProvider === 'openai')!;
    assert.ok(anthropicStats.usd > 0, 'anthropic row is priced');
    assert.equal(openaiStats.usd, 0, 'openai row is NOT priced');
    db.close();
  });

  it('computeDailyStats logic: distinct count, median/p90, non-anthropic excluded from USD', () => {
    const db = openTelemetryDb(':memory:');
    const pricing = pricingFromEnv({});
    db.exec(`
      INSERT INTO router_logs (final_provider, route_reason, latency_ms, prompt_id, tokens_in, cache_write_tokens, requested_model, outcome, created_at) VALUES 
      ('anthropic', 'reason', 5, 'p1', 1000000, 1000000, 'claude-sonnet-5', 'ok', 1000000),
      ('anthropic', 'reason', 5, 'p2', 2000000, 2000000, 'claude-sonnet-5', 'ok', 1000000),
      ('anthropic', 'reason', 5, 'p3', 3000000, 3000000, 'claude-sonnet-5', 'ok', 1000000),
      ('anthropic', 'reason', 5, 'p3', 1000000, 1000000, 'claude-sonnet-5', 'ok', 1000000),
      ('openai', 'reason', 5, 'p4', 4000000, 4000000, 'claude-sonnet-5', 'ok', 1000000)
    `);
    const stats = computeDailyStats(db, pricing, {});
    assert.equal(stats.tasks, 4);
    assert.equal(stats.median, 5); // median of [0, 2.5, 5, 10]
    assert.equal(stats.p90, 10);
    
    const render = renderDailyStats(stats);
    assert.ok(render.includes('Tasks overall: 4'));
    assert.ok(render.includes('\n'), 'uses real newlines');
    assert.ok(!render.includes('\\n'), 'does not use literal backslash-n');
    db.close();
  });

  it('pricing rows for claude-sonnet-5-5, claude-sonnet-5 and claude-haiku-5-5', () => {
    assert.equal(anthropicListPrice('claude-sonnet-5-5')?.cacheRead, 0.1);
    assert.equal(anthropicListPrice('claude-sonnet-5')?.cacheRead, 0.2);
    assert.equal(anthropicListPrice('claude-haiku-5-5')?.cacheRead, 0.01);
    
    // Test that they resolve properly by prefix
    assert.equal(anthropicListPrice('claude-sonnet-5-5-anything')?.cacheRead, 0.1);
    assert.equal(anthropicListPrice('claude-sonnet-5-anything')?.cacheRead, 0.2);
  });

  it('5m/1h-aware USD pricing in computeNetCost', () => {
    const pricing = pricingFromEnv({});
    const row: any = {
      id: 1,
      sessionId: 's1',
      finalProvider: 'anthropic',
      requestedModel: 'claude-sonnet-5-5', // input 2, output 10, read 0.1
      outcome: 'ok',
      tokensIn: 1000000, // 1M input tokens
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000000,
      cacheWrite5mTokens: 800000,
      cacheWrite1hTokens: 200000,
      jevTokensIn: null,
      jevTokensOut: null,
    };
    
    const cost = computeNetCost([row], pricing);
    // Write cost with 5m/1h split: (800000 * 1.25 + 200000 * 2) = 1,400,000 * 2 (input price) = 2.8M USD equivalent.
    // Plus input 2 = 0? wait, `Math.max(0, tin - read - write)` is 0. So just writeCost.
    // 2.8 USD total.
    assert.ok(Math.abs(cost.anthropicUsd - 2.8) < 1e-6);
  });
});

import { buildServer } from '../src/proxy/server.js';
import type { Config } from '../src/config.js';
import type { Router } from '../src/routing/router.js';

describe('R0 Diagnostics - Fastify Server', () => {
  it('capture with TELEMETRY_DIAGNOSTICS off writes no new header/hash fields and with it on writes them', async () => {
    let capturedDiagnosticsOff: any;
    let capturedDiagnosticsOn: any;

    const mockRouter: Router = {
      decide: async () => ({ tier: 'primary', route: 'primary', reason: 'sticky', fallbackTier: 'primary', conversationKey: 'x', distribution: null }),
      pinToPrimary: () => {},
    } as any;

    const mockProvider = {
      send: async () => ({ kind: 'response', status: 200, headers: {}, body: Readable.from([]) } as any)
    };


    const makeApp = (diagnosticsOn: boolean, captureRef: (d: any) => void) => buildServer({
      config: { 
        telemetry: { diagnostics: diagnosticsOn }, 
        primary: { authMode: 'passthrough' },
        cheap: { model: 'g' },
        router: {}
      } as unknown as Config,
      router: mockRouter,
      providers: { primary: mockProvider, cheap: mockProvider } as any,
      telemetry: {
        record: (row: any) => captureRef(row),
        flush: () => {},
        close: async () => {},
      } as any,
    });


    const appOff = makeApp(false, (d) => capturedDiagnosticsOff = d);
    await appOff.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'x-claude-code-session-id': 'sess1',
        'x-claude-code-agent-type': 'agent1'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    

    // We expect telemetry processing to complete shortly after the response finishes.
    // Since auditExchange uses setTimeout/Promise.race, we can just await a bit.
    await new Promise(r => setTimeout(r, 50));
    
    assert.ok(capturedDiagnosticsOff);
    assert.equal(capturedDiagnosticsOff.ccSessionId, null, 'No ccSessionId captured when off');
    assert.equal(capturedDiagnosticsOff.agentType, null);
    assert.equal(capturedDiagnosticsOff.systemHash, null);

    const appOn = makeApp(true, (d) => capturedDiagnosticsOn = d);
    await appOn.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'x-claude-code-session-id': 'sess2',
        'x-claude-code-agent-type': 'agent2'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-5',
        system: 'hello world',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    
    await new Promise(r => setTimeout(r, 50));
    assert.ok(capturedDiagnosticsOn);
    assert.equal(capturedDiagnosticsOn.ccSessionId, 'sess2');
    assert.equal(capturedDiagnosticsOn.agentType, 'agent2');
    assert.ok(capturedDiagnosticsOn.systemHash);
    assert.equal(capturedDiagnosticsOn.systemChars, 13); // 'hello world' length + quotes
  });
});

