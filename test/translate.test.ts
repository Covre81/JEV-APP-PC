import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSseData } from '../src/providers/openai/sse.js';
import { NotTranslatableError, toChatCompletion } from '../src/providers/openai/translate-request.js';
import { toAnthropicMessage, toAnthropicStream, TranslationError } from '../src/providers/openai/translate-response.js';
import { MessagesBody } from '../src/routing/messages-body.js';

const opts = { model: 'openai/gpt-oss-20b', maxOutputTokens: 8_192 };

const claudeCodeTurn = MessagesBody.parse({
  model: 'claude-opus-5-5',
  max_tokens: 64_000,
  stream: true,
  thinking: { type: 'adaptive' },
  system: [
    { type: 'text', text: 'attribution' },
    { type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } },
  ],
  tools: [
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'mcp__big__tool', input_schema: { type: 'object' }, defer_loading: true },
    { type: 'web_search_20260209', name: 'web_search' },
  ],
  tool_choice: { type: 'auto' },
  messages: [
    { role: 'user', content: 'read a.ts' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export {}' }] },
        { type: 'text', text: '<system-reminder>x</system-reminder>' },
      ],
    },
  ],
});

describe('toChatCompletion', () => {
  it('translates a Claude Code agent-loop turn', () => {
    const chat = toChatCompletion(claudeCodeTurn, opts);
    assert.equal(chat.model, 'openai/gpt-oss-20b');
    assert.equal(chat.max_tokens, 8_192);
    assert.deepEqual(chat.stream_options, { include_usage: true });
    assert.deepEqual(chat.messages, [
      { role: 'system', content: 'attribution\n\nYou are Claude Code' },
      { role: 'user', content: 'read a.ts' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'export {}' },
      { role: 'user', content: '<system-reminder>x</system-reminder>' },
    ]);
    assert.deepEqual(
      chat.tools?.map((t) => t.function.name),
      ['Read'],
      'server tools and deferred tools are not exposed',
    );
    assert.equal(chat.tool_choice, 'auto');
    assert.equal('thinking' in chat, false);
  });

  it('refuses content it cannot map faithfully', () => {
    const withImage = MessagesBody.parse({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: '' } }] }],
    });
    assert.throws(() => toChatCompletion(withImage, opts), NotTranslatableError);
  });

  it('marks failed tool results', () => {
    const body = MessagesBody.parse({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] }],
    });
    assert.deepEqual(toChatCompletion(body, opts).messages, [{ role: 'tool', tool_call_id: 't', content: 'Error: boom' }]);
  });
});

describe('toAnthropicMessage', () => {
  it('maps text, tool calls, stop reason and usage', () => {
    const msg = toAnthropicMessage(
      {
        choices: [
          {
            message: {
              content: 'On it.',
              tool_calls: [{ id: 'call.1', type: 'function', function: { name: 'Read', arguments: '{"path":"b.ts"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      'openai/gpt-oss-20b',
    ) as Record<string, unknown>;
    assert.equal(msg['stop_reason'], 'tool_use');
    assert.deepEqual(msg['content'], [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'b.ts' } },
    ]);
    assert.deepEqual(msg['usage'], { input_tokens: 10, output_tokens: 5 });
  });

  it('rejects invalid tool arguments instead of executing a broken call', () => {
    const bad = {
      choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'Bash', arguments: '{"cmd": "ls' } }] }, finish_reason: 'tool_calls' }],
    };
    assert.throws(() => toAnthropicMessage(bad, 'm'), TranslationError);
  });
});

async function* chunks(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p);
}

const events = (sse: string) =>
  sse
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(e.split('\n')[1]!.slice('data: '.length)) as Record<string, any>);

describe('toAnthropicStream', () => {
  it('produces a well-formed Anthropic event sequence', async () => {
    const openAi = chunks(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    );
    let out = '';
    for await (const e of toAnthropicStream(readSseData(openAi), 'm')) out += e;
    const ev = events(out);

    assert.deepEqual(
      ev.map((e) => e.type),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    );
    assert.deepEqual(ev[5]?.content_block, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} });
    assert.equal(ev[6]?.delta.partial_json, '{"path":"a"}');
    assert.equal(ev[8]?.delta.stop_reason, 'tool_use');
    assert.deepEqual(ev[8]?.usage, { input_tokens: 7, output_tokens: 3 });
  });

  it('throws when the upstream stream is truncated', async () => {
    const truncated = chunks('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    await assert.rejects(async () => {
      for await (const _ of toAnthropicStream(readSseData(truncated), 'm'));
    }, TranslationError);
  });
});

describe('readSseData', () => {
  it('handles split chunks, CRLF and comments', async () => {
    const out: string[] = [];
    for await (const d of readSseData(chunks(': ping\r\n\r\ndata: {"a"', ':1}\r\n\r\ndata: [DONE]\n\n'))) out.push(d);
    assert.deepEqual(out, ['{"a":1}', '[DONE]']);
  });
});
