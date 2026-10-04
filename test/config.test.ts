import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { CLASSIFIER: 'heuristic', CHEAP_API_KEY: 'x' };

describe('loadConfig security guards', () => {
  it('requires ANTHROPIC_API_KEY in inject mode', () => {
    assert.throws(() => loadConfig({ ...base, UPSTREAM_AUTH_MODE: 'inject' }), /ANTHROPIC_API_KEY/);
  });

  it('refuses a key-injecting proxy off loopback without PROXY_AUTH_TOKEN', () => {
    const inject = { ...base, UPSTREAM_AUTH_MODE: 'inject', ANTHROPIC_API_KEY: 'sk-ant-test' };
    assert.throws(() => loadConfig({ ...inject, HOST: '0.0.0.0' }), /PROXY_AUTH_TOKEN/);
    assert.equal(loadConfig({ ...inject, HOST: '0.0.0.0', PROXY_AUTH_TOKEN: 'proxy-token-0123456789' }).host, '0.0.0.0');
    assert.equal(loadConfig(inject).host, '127.0.0.1', 'loopback needs no token');
  });

  it('rejects a proxy token shorter than 16 characters', () => {
    assert.throws(() => loadConfig({ ...base, PROXY_AUTH_TOKEN: 'short' }), /PROXY_AUTH_TOKEN/);
  });
});
