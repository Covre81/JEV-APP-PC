import { Readable } from 'node:stream';
import type { Provider, ProviderRequest, ProviderResult } from '../provider.js';
import { runAgy, type AgyRunnerOptions, type SpawnAgy } from './agy-runner.js';
import { renderGeminiPrompt } from './prompt.js';
import { sseEvent } from '../openai/sse.js';
import { CircuitBreaker } from './breaker.js';

export class GeminiCliProvider implements Provider {
  readonly name = 'gemini-cli';

  constructor(
    private readonly opts: {
      readonly bin: string;
      readonly model: string;
      readonly timeoutMs: number;
      readonly home: string;
      readonly maxPromptChars: number;
      readonly spawnFn?: SpawnAgy;
    }
  ) {}

  async send(req: ProviderRequest): Promise<ProviderResult> {
    if (!req.body) {
      return { kind: 'unavailable', reason: 'no body' };
    }

    const prompt = renderGeminiPrompt(req.body, this.opts.maxPromptChars);
    if (!prompt) {
      return { kind: 'unavailable', reason: 'transcript budget exceeded' };
    }

    const runnerOpts: AgyRunnerOptions = {
      bin: this.opts.bin,
      model: this.opts.model,
      timeoutMs: this.opts.timeoutMs,
      home: this.opts.home,
      signal: req.signal,
    };

    const res = await runAgy(prompt, runnerOpts, this.opts.spawnFn);

    if (!res.ok) {
      return { kind: 'unavailable', reason: res.reason };
    }

    const text = res.text.trim();
    if (text.startsWith('JEV_NEEDS_TOOLS') || text === 'JEV_NEEDS_TOOLS') {
      return { kind: 'unavailable', reason: 'model asked for tools' };
    }

    const usage = res.usage;

    const headers = {
      'content-type': req.body.stream ? 'text/event-stream' : 'application/json',
      'x-claude-code-provider': 'gemini-cli'
    };

    if (req.body.stream) {
      async function* generateStream() {
        yield sseEvent('message_start', {
          message: {
            id: `msg_jev_gemini_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: req.body!.model,
            usage: { input_tokens: usage.inputTokens, output_tokens: 0 }
          }
        });

        yield sseEvent('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' }
        });

        const chunkLen = 2000;
        for (let i = 0; i < text.length; i += chunkLen) {
          yield sseEvent('content_block_delta', {
            index: 0,
            delta: { type: 'text_delta', text: text.slice(i, i + chunkLen) }
          });
        }

        yield sseEvent('content_block_stop', { index: 0 });

        yield sseEvent('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.outputTokens }
        });

        yield sseEvent('message_stop', {});
      }

      return {
        kind: 'response',
        status: 200,
        headers,
        body: Readable.from(generateStream())
      };
    } else {
      const responseJson = {
        id: `msg_jev_gemini_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: req.body.model,
        content: [{ type: 'text', text: text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: res.usage.inputTokens,
          output_tokens: res.usage.outputTokens
        }
      };

      return {
        kind: 'response',
        status: 200,
        headers,
        body: Readable.from([JSON.stringify(responseJson)])
      };
    }
  }
}
