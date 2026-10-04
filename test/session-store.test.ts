import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TtlLruStore } from '../src/routing/session-store.js';

describe('TtlLruStore', () => {
  it('forgets an entry once its TTL has passed', () => {
    let now = 0;
    const store = new TtlLruStore<string>(10, 1_000, () => now);
    store.set('a', 'cheap');
    now = 999;
    assert.equal(store.get('a'), 'cheap');
    now = 2_000;
    assert.equal(store.get('a'), undefined);
  });

  it('evicts the least recently used entry beyond capacity', () => {
    const store = new TtlLruStore<string>(2, 60_000);
    store.set('a', '1');
    store.set('b', '2');
    store.get('a'); // a becomes the most recent
    store.set('c', '3'); // evicts b
    assert.equal(store.get('b'), undefined);
    assert.equal(store.get('a'), '1');
    assert.equal(store.get('c'), '3');
  });
});
