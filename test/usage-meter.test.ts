import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { meterAnthropicBody } from '../src/telemetry/usage-meter.js';

const collect = async (r: Readable) => Buffer.concat(await r.toArray());

/** Splits a payload into awkward chunks so SSE lines straddle chunk boundaries. */
const chunked = (buf: Buffer, size = 7) =>
  Readable.from(Array.from({ length: Math.ceil(buf.length / size) }, (_, i) => buf.subarray(i * size, (i + 1) * size)));

const sse = Buffer.from(
  [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":5000,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"usage is a word"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\r\n'),
);

describe('meterAnthropicBody', () => {
  it('reads SSE usage across chunk boundaries and relays the bytes unchanged', async () => {
    const m = meterAnthropicBody(chunked(sse), 'text/event-stream', undefined);
    assert.deepEqual(await collect(m.body), sse);
    await m.settled;
    assert.deepEqual(m.usage(), { tokensIn: 5312, tokensOut: 42, cacheReadTokens: 5000, cacheWriteTokens: 300 });
    assert.equal(m.sawErrorEvent(), false);
  });

  it('decodes a gzip body on a side channel while relaying the compressed bytes', async () => {
    const json = Buffer.from(JSON.stringify({ type: 'message', usage: { input_tokens: 7, output_tokens: 3 } }));
    const gz = gzipSync(json);
    const m = meterAnthropicBody(chunked(gz, 5), 'application/json', 'gzip');
    assert.deepEqual(await collect(m.body), gz);
    await m.settled;
    assert.deepEqual(m.usage(), { tokensIn: 7, tokensOut: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('flags an Anthropic error event inside a 200 stream', async () => {
    const body = Buffer.from('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n');
    const m = meterAnthropicBody(Readable.from([body]), 'text/event-stream', undefined);
    await collect(m.body);
    await m.settled;
    assert.equal(m.sawErrorEvent(), true);
    assert.equal(m.usage(), undefined);
  });

  it('counts the tool calls of an SSE response, even with "tool_use" split across chunks', async () => {
    const body = Buffer.from(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"tool_use is a word"}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t2","name":"Bash","input":{}}}',
        '',
        '',
      ].join('\n'),
    );
    const m = meterAnthropicBody(chunked(body, 5), 'text/event-stream', undefined);
    await collect(m.body);
    await m.settled;
    assert.equal(m.toolCalls(), 2);
  });

  it('counts the tool calls of a JSON response, and zero for a text-only answer', async () => {
    const withTools = Buffer.from(
      JSON.stringify({
        content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const m = meterAnthropicBody(Readable.from([withTools]), 'application/json', undefined);
    await collect(m.body);
    await m.settled;
    assert.equal(m.toolCalls(), 1);

    const textOnly = meterAnthropicBody(chunked(sse), 'text/event-stream', undefined);
    await collect(textOnly.body);
    await textOnly.settled;
    assert.equal(textOnly.toolCalls(), 0);
  });

  it('never breaks the relay on garbage', async () => {
    const junk = Buffer.from('{not json');
    const m = meterAnthropicBody(Readable.from([junk]), 'application/json', 'gzip');
    assert.deepEqual(await collect(m.body), junk);
    await m.settled;
    assert.equal(m.usage(), undefined);
  });
});
