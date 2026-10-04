import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeNetCost, type CostRow } from '../src/telemetry/cost.js';
import { anthropicListPrice, pricingFromEnv } from '../src/telemetry/pricing.js';

// Round prices make the arithmetic checkable by hand:
// Anthropic $10 in / $50 out / $1 cache read, write = 1.25 × $10; cheap $1 in / $2 out.
const pricing = pricingFromEnv({
  PRIMARY_PRICE_INPUT_PER_MTOK: '10',
  PRIMARY_PRICE_OUTPUT_PER_MTOK: '50',
  PRIMARY_PRICE_CACHE_READ_PER_MTOK: '1',
  CHEAP_PRICE_INPUT_PER_MTOK: '1',
  CHEAP_PRICE_OUTPUT_PER_MTOK: '2',
});

let nextId = 1;
const row = (over: Partial<CostRow>): CostRow => ({
  id: nextId++,
  sessionId: 's',
  finalProvider: 'anthropic',
  model: 'claude-opus-5-5',
  requestedModel: 'claude-opus-5-5',
  outcome: 'ok',
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

const M = 1_000_000;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

describe('computeNetCost', () => {
  it('credits a cheap turn only with the warm-cache Anthropic price', () => {
    const c = computeNetCost(
      [
        row({ tokensIn: M, cacheWriteTokens: M, tokensOut: 0 }), // anthropic: 1M written = $12.50
        row({ finalProvider: 'openai', model: 'gpt-oss', tokensIn: 1.1 * M, tokensOut: 0.1 * M }),
      ],
      pricing,
    );
    // Cheap actual: 1.1 × $1 + 0.1 × $2 = $1.30.
    // Warm Anthropic: 1M history read ($1) + 0.1M new written ($1.25) + 0.1M out ($5) = $7.25.
    close(c.cheapUsd, 1.3);
    close(c.grossSavingsUsd, 7.25 - 1.3);
    close(c.netUsd, 7.25 - 1.3);
    assert.equal(c.transitions, 0);
  });

  it('books the cache-miss penalty when the conversation returns to Anthropic', () => {
    const c = computeNetCost(
      [
        row({ tokensIn: M, cacheWriteTokens: M }), // $12.50
        row({ finalProvider: 'openai', model: 'gpt-oss', tokensIn: 1.1 * M, tokensOut: 0 }), // cheap $1.10, warm $2.25
        row({ tokensIn: 1.2 * M, cacheWriteTokens: 1.2 * M, tokensOut: 0 }), // cold: 1.2M written = $15
      ],
      pricing,
    );
    // Warm counterfactual for the return: 1.1M read ($1.10) + 0.1M written ($1.25) = $2.35.
    close(c.cachePenaltyUsd, 15 - 2.35);
    assert.equal(c.transitions, 1);
    // Net = gross (2.25 − 1.10) − penalty (12.65) = −11.50: the router lost money.
    close(c.netUsd, 2.25 - 1.1 - (15 - 2.35));
    close(c.netUsd, c.grossSavingsUsd - c.failedCheapUsd - c.cachePenaltyUsd);
  });

  it('charges a failed cheap attempt without crediting any saving', () => {
    const c = computeNetCost(
      [
        row({ finalProvider: 'openai', outcome: 'stream_error', tokensIn: M, tokensOut: 0 }), // $1 wasted
        row({ tokensIn: M, cacheWriteTokens: M }), // retry on Anthropic, cold
      ],
      pricing,
    );
    close(c.failedCheapUsd, 1);
    close(c.grossSavingsUsd, 0);
    // The retry is the conversation's first served turn: no history, so no penalty.
    close(c.cachePenaltyUsd, 0);
    close(c.netUsd, -1);
  });

  it('never links rows across sessions and flags missing usage and prices', () => {
    const c = computeNetCost(
      [
        row({ sessionId: 'a', finalProvider: 'openai', tokensIn: M }),
        row({ sessionId: 'b', tokensIn: M, cacheWriteTokens: M }),
        row({ sessionId: 'b', tokensIn: null, tokensOut: null }),
      ],
      pricing,
    );
    assert.equal(c.transitions, 0);
    assert.equal(c.rowsWithoutUsage, 1);
    const unpriced = computeNetCost([row({ requestedModel: 'claude-unknown-9' })], pricingFromEnv({}));
    assert.deepEqual(unpriced.unpricedModels, ['claude-unknown-9']);
  });

  it('resolves list prices by longest prefix', () => {
    assert.equal(anthropicListPrice('claude-opus-5-5[1m]')?.input, 4);
    assert.equal(anthropicListPrice('claude-opus-5')?.input, 5);
    assert.equal(anthropicListPrice('claude-fable-5-1')?.cacheRead, 0.25);
    assert.equal(anthropicListPrice('gpt-oss'), undefined);
  });
});
