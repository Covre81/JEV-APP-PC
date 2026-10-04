import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toDistribution } from '../src/domain/complexity.js';
import { selectRoute, stickyRoute } from '../src/domain/policy.js';

const options = { minCheapProbability: 0.8, standardRoute: 'primary' } as const;

describe('selectRoute', () => {
  it('sends confidently simple work to the cheap provider', () => {
    assert.equal(selectRoute({ simple: 0.9, standard: 0.08, structural: 0.02 }, options), 'cheap');
  });

  it('keeps structural work on the primary', () => {
    assert.equal(selectRoute({ simple: 0.05, standard: 0.15, structural: 0.8 }, options), 'primary');
  });

  it('is not argmax: a weakly simple mode stays on the primary', () => {
    assert.equal(selectRoute({ simple: 0.45, standard: 0.3, structural: 0.25 }, options), 'primary');
  });

  it('can opt level-2 work into the cheap provider', () => {
    const d = { simple: 0.4, standard: 0.45, structural: 0.15 };
    assert.equal(selectRoute(d, options), 'primary');
    assert.equal(selectRoute(d, { ...options, standardRoute: 'cheap' }), 'cheap');
  });
});

describe('selectRoute risk veto', () => {
  it('keeps confidently simple but risky work on the primary', () => {
    const d = { simple: 0.96, standard: 0.03, structural: 0.01 };
    assert.equal(selectRoute({ ...d, risk: 0.94 }, options), 'primary');
    assert.equal(selectRoute({ ...d, risk: 0.15 }, options), 'cheap');
    assert.equal(selectRoute(d, options), 'cheap');
  });
});

describe('stickyRoute', () => {
  it('escalates but never de-escalates', () => {
    assert.equal(stickyRoute('cheap', 'primary'), 'primary');
    assert.equal(stickyRoute('primary', 'cheap'), 'primary');
    assert.equal(stickyRoute('cheap', 'cheap'), 'cheap');
  });
});

describe('toDistribution', () => {
  it('normalizes and rejects an empty distribution', () => {
    assert.deepEqual(toDistribution(2, 1, 1), { simple: 0.5, standard: 0.25, structural: 0.25 });
    assert.throws(() => toDistribution(0, 0, 0));
  });
});
