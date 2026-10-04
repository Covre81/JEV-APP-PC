/**
 * Real calls through AnthropicProvider (the primary, byte-level forwarder) to
 * check what the offline fakes can't: Anthropic's live SSE stream, rate-limit
 * headers and error bodies reach the client intact.
 *
 *   npx tsx scripts/smoke-anthropic.ts [--env <file>] [--model claude-haiku-4-5]
 *
 * Needs ANTHROPIC_API_KEY (ANTHROPIC_UPSTREAM_URL optional). Two small calls
 * (~30 output tokens). Never runs in CI.
 * Exit 0 = all checks pass, 1 = something broke, 2 = setup error.
 */
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../src/env.js';
import type { HeaderMap } from '../src/proxy/headers.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { ProviderResult } from '../src/providers/provider.js';

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_UPSTREAM_URL: z.url().default('https://api.anthropic.com'),
});

/** The headers Claude Code sends that matter to the forwarder. */
const CLIENT_HEADERS: HeaderMap = {
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
  accept: 'application/json',
  'accept-encoding': 'gzip, deflate, br',
};

/** Events Claude Code needs, in order, for a plain text turn. */
const REQUIRED_EVENTS = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];

let failures = 0;
const ok = (msg: string) => console.log(`OK   ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.error(`FAIL ${msg}`);
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      model: { type: 'string', default: 'claude-haiku-4-5' },
    },
  });
  const envFile = loadEnv(values.env);
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(`Setup error (env file: ${envFile ?? 'none'}):`);
    for (const i of env.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
    return 2;
  }
  const provider = new AnthropicProvider({
    baseUrl: env.data.ANTHROPIC_UPSTREAM_URL.replace(/\/+$/, ''),
    timeoutMs: 60_000,
    authMode: 'inject',
    apiKey: env.data.ANTHROPIC_API_KEY,
  });
  console.log(`${env.data.ANTHROPIC_UPSTREAM_URL}  model=${values.model}  env=${envFile ?? 'shell'}\n`);

  await streamingTurn(provider, values.model);
  await errorPassthrough(provider);
  return failures === 0 ? 0 : 1;
}

/** 1. A streamed turn: status, SSE content type, rate-limit headers, full event sequence. */
async function streamingTurn(provider: AnthropicProvider, model: string): Promise<void> {
  const result = await send(provider, {
    model,
    max_tokens: 32,
    stream: true,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  });
  if (result.kind !== 'response') return fail(`streaming turn: provider unavailable (${result.reason})`);
  const { text, encoding } = await readBody(result.body, result.headers);
  if (result.status !== 200) return fail(`streaming turn: HTTP ${result.status}\n${text}`);
  ok(`streaming turn: HTTP 200 (content-encoding: ${encoding ?? 'none'})`);

  const type = String(result.headers['content-type'] ?? '');
  if (type.startsWith('text/event-stream')) ok(`content-type ${type}`);
  else fail(`content-type is "${type}", expected text/event-stream`);

  const rateLimit = Object.keys(result.headers).filter((h) => h.startsWith('anthropic-ratelimit-'));
  if (rateLimit.length > 0) ok(`rate-limit headers forwarded: ${rateLimit.length} (${rateLimit[0]}, ...)`);
  else fail('no anthropic-ratelimit-* headers: Claude Code loses its quota signal');
  if (result.headers['request-id']) ok(`request-id ${String(result.headers['request-id'])}`);
  else fail('no request-id header');

  const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!);
  const missing = REQUIRED_EVENTS.filter((e) => !events.includes(e));
  const ordered = REQUIRED_EVENTS.map((e) => events.indexOf(e)).every((i, n, all) => n === 0 || i > all[n - 1]!);
  if (missing.length > 0) fail(`SSE missing events: ${missing.join(', ')}\n${text}`);
  else if (!ordered) fail(`SSE events out of order: ${events.join(' ')}`);
  else ok(`SSE sequence: ${events.length} events, message_start ... message_stop`);

  const reply = [...text.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join('');
  console.log(`     reply: ${JSON.stringify(reply)}`);
}

/** 2. An upstream error must reach the client as Anthropic's own JSON error, not a proxy error. */
async function errorPassthrough(provider: AnthropicProvider): Promise<void> {
  const result = await send(provider, {
    model: 'claude-does-not-exist',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'x' }],
  });
  if (result.kind !== 'response') return fail(`error passthrough: provider unavailable (${result.reason})`);
  const { text } = await readBody(result.body, result.headers);
  if (result.status < 400 || result.status >= 500) return fail(`error passthrough: expected 4xx, got ${result.status}\n${text}`);
  const Err = z.object({ type: z.literal('error'), error: z.object({ type: z.string(), message: z.string() }) });
  const parsed = Err.safeParse(safeJson(text));
  if (parsed.success) ok(`error passthrough: HTTP ${result.status} ${parsed.data.error.type}`);
  else fail(`error passthrough: HTTP ${result.status} body is not an Anthropic error\n${text}`);
}

function send(provider: AnthropicProvider, body: object): Promise<ProviderResult> {
  const rawBody = Buffer.from(JSON.stringify(body));
  return provider.send({
    method: 'POST',
    url: '/v1/messages',
    // Placeholder client credential: inject mode must replace it.
    headers: { ...CLIENT_HEADERS, 'x-api-key': 'client-placeholder' },
    rawBody,
    body: undefined,
    signal: AbortSignal.timeout(60_000),
  });
}

/** The forwarder never decompresses; decode here only to inspect what the client would get. */
async function readBody(body: Readable, headers: HeaderMap): Promise<{ text: string; encoding: string | undefined }> {
  const encoding = headers['content-encoding'] ? String(headers['content-encoding']) : undefined;
  const decoder =
    encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined;
  const stream = decoder ? body.pipe(decoder) : body;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return { text: Buffer.concat(chunks).toString('utf8'), encoding };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
