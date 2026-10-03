import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectTier } from '../src/domain/policy.js';

describe('selectTier', () => {
  it('picks the cheapest tier that clears the threshold', () => {
    assert.equal(selectTier({ scores: { haiku: 90, sonnet: 60, opus: 45 }, threshold: 80, ceiling: 'opus' }), 'haiku');
    assert.equal(selectTier({ scores: { haiku: 40, sonnet: 85, opus: 100 }, threshold: 80, ceiling: 'opus' }), 'sonnet');
  });

  it('fails up to the ceiling when nothing is confident enough', () => {
    assert.equal(selectTier({ scores: { haiku: 10, sonnet: 20, opus: 30 }, threshold: 80, ceiling: 'opus' }), 'opus');
    assert.equal(selectTier({ scores: { haiku: 10, sonnet: 20, opus: 30 }, threshold: 80, ceiling: 'sonnet' }), 'sonnet');
  });

  it('never exceeds the ceiling', () => {
    assert.equal(selectTier({ scores: { haiku: 0, sonnet: 0, opus: 100 }, threshold: 80, ceiling: 'haiku' }), 'haiku');
  });

  it('skips excluded tiers', () => {
    const excluded = new Set(['haiku'] as const);
    assert.equal(selectTier({ scores: { haiku: 99, sonnet: 99, opus: 100 }, threshold: 80, ceiling: 'opus', excluded }), 'sonnet');
  });
});
