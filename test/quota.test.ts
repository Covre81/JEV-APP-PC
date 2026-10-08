import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindingUtilization, parseQuotaHeaders, QuotaStore, quotaLevel } from '../src/quota.js';

const levels = { pressure: 0.8, critical: 0.95 };

describe('parseQuotaHeaders', () => {
  it('reads the unified 5h and 7d windows of a claude.ai login', () => {
    const q = parseQuotaHeaders({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.82',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': '1791374400',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '2026-10-10T00:00:00Z',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-fallback-percentage': '0.5',
      'content-type': 'text/event-stream',
    });
    assert.deepEqual(
      q.windows.map((w) => [w.name, w.utilization]),
      [
        ['5h', 0.82],
        ['7d', 0.4],
      ],
      'overage is not a window',
    );
    assert.equal(q.windows[0]!.resetAt?.toISOString(), new Date(1791374400 * 1000).toISOString());
    assert.equal(q.windows[1]!.resetAt?.toISOString(), '2026-10-10T00:00:00.000Z');
    assert.equal(q.status, 'allowed');
    const binding = bindingUtilization(q);
    assert.deepEqual(binding, { utilization: 0.82, window: '5h' });
  });

  it('counts a rejected or rate-limited window as full', () => {
    const q = parseQuotaHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.6',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
    });
    assert.deepEqual(bindingUtilization(q), { utilization: 1, window: '7d' });
    assert.equal(bindingUtilization(parseQuotaHeaders({ 'anthropic-ratelimit-unified-5h-status': 'rate_limited' }))?.utilization, 1);
  });

  it('accepts other windows and any header case', () => {
    const q = parseQuotaHeaders({ 'Anthropic-RateLimit-Unified-7d_opus-Utilization': '0.91' });
    assert.deepEqual(bindingUtilization(q), { utilization: 0.91, window: '7d_opus' });
  });

  it('derives utilization from limit/remaining with an API key', () => {
    const q = parseQuotaHeaders({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '45',
      'anthropic-ratelimit-tokens-limit': '100000',
      'anthropic-ratelimit-tokens-remaining': '10000',
      'anthropic-ratelimit-tokens-reset': '2026-10-07T12:00:00Z',
    });
    assert.deepEqual(bindingUtilization(q), { utilization: 0.9, window: 'tokens' });
  });

  it('has nothing to say without rate-limit headers', () => {
    assert.equal(bindingUtilization(parseQuotaHeaders({ 'content-type': 'application/json' })), undefined);
  });
});

describe('quotaLevel', () => {
  it('maps utilization to none, pressure and critical', () => {
    assert.equal(quotaLevel(undefined, levels), 'none');
    assert.equal(quotaLevel(0.79, levels), 'none');
    assert.equal(quotaLevel(0.8, levels), 'pressure');
    assert.equal(quotaLevel(0.95, levels), 'critical');
  });
});

describe('QuotaStore', () => {
  it('keeps the latest reading and reports only meaningful changes', () => {
    const changes: number[] = [];
    const store = new QuotaStore(levels, (s) => changes.push(s.utilization));
    store.observe({ 'anthropic-ratelimit-unified-5h-utilization': '0.50' });
    store.observe({ 'anthropic-ratelimit-unified-5h-utilization': '0.505' });
    store.observe({ 'content-type': 'application/json' }); // no headers: keeps the last reading
    store.observe({ 'anthropic-ratelimit-unified-5h-utilization': '0.83' });
    assert.deepEqual(changes, [0.5, 0.83]);
    assert.equal(store.level(), 'pressure');
    assert.equal(store.current()?.window, '5h');
  });

  it('reports a status change even when utilization does not move', () => {
    const changes: string[] = [];
    const store = new QuotaStore(levels, (s) => changes.push(s.status ?? '-'));
    store.observe({ 'anthropic-ratelimit-unified-5h-utilization': '0.5', 'anthropic-ratelimit-unified-status': 'allowed' });
    store.observe({ 'anthropic-ratelimit-unified-5h-utilization': '0.5', 'anthropic-ratelimit-unified-status': 'allowed_warning' });
    assert.deepEqual(changes, ['allowed', 'allowed_warning']);
  });
});
