import { test, describe, afterEach, beforeEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { runAgy } from '../src/providers/gemini/agy-runner.js';
import { renderGeminiPrompt } from '../src/providers/gemini/prompt.js';
import { GeminiCliProvider } from '../src/providers/gemini/provider.js';

describe('Gemini runner', () => {
  test('success parse', async () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.stdin = new Writable({ write() {} });
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.pid = 12345;
    
    const spawnFn = mock.fn((bin, args, opts) => {
      // simulate output
      setTimeout(() => {
        fakeChild.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hello ' } }) + '\n'));
        fakeChild.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'hello world', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n'));
        fakeChild.emit('close', 0);
      }, 10);
      return fakeChild;
    });

    const res = await runAgy('hello', { bin: 'agy', model: 'test', timeoutMs: 1000, home: 'home' }, spawnFn as any);
    assert.deepEqual(res, { ok: true, text: 'hello world', usage: { inputTokens: 10, outputTokens: 2 } });
  });
});
