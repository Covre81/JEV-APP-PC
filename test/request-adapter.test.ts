import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profileFor } from '../src/domain/model-catalog.js';
import { MessagesBody } from '../src/routing/messages-body.js';
import { adaptForModel } from '../src/routing/request-adapter.js';

const body = MessagesBody.parse({
  model: 'claude-opus-5-5',
  max_tokens: 128_000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'xhigh', format: { type: 'json_schema', schema: {} } },
  speed: 'fast',
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'hi' }],
  some_future_field: { keep: true },
});

describe('adaptForModel', () => {
  it('strips what Haiku 4.5 rejects and nothing else', () => {
    const out = adaptForModel(body, 'claude-haiku-4-5', profileFor('claude-haiku-4-5'));
    assert.equal(out.model, 'claude-haiku-4-5');
    assert.equal(out.max_tokens, 64_000);
    assert.equal(out.thinking, undefined);
    assert.equal(out.speed, undefined);
    assert.deepEqual(out.output_config, { format: { type: 'json_schema', schema: {} } });
    assert.deepEqual(out['system'], body['system']);
    assert.deepEqual(out.messages, body.messages);
    assert.deepEqual(out['some_future_field'], { keep: true });
  });

  it('keeps adaptive thinking and effort for Sonnet 5.5 but drops fast mode', () => {
    const out = adaptForModel(body, 'claude-sonnet-5-5', profileFor('claude-sonnet-5-5'));
    assert.deepEqual(out.thinking, { type: 'adaptive' });
    assert.equal(out.output_config?.['effort'], 'xhigh');
    assert.equal(out.speed, undefined);
    assert.equal(out.max_tokens, 128_000);
  });

  it('does not mutate the input', () => {
    adaptForModel(body, 'claude-haiku-4-5', profileFor('claude-haiku-4-5'));
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.equal(body.output_config?.['effort'], 'xhigh');
  });
});
