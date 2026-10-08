import { StringDecoder } from 'node:string_decoder';
import { pipeline, Transform, type Readable, type TransformCallback } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, type Gunzip } from 'node:zlib';

/** Token usage of one Anthropic Messages response. */
export interface Usage {
  /** Total prompt tokens: uncached input + cache writes + cache reads. */
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  /** Portion of tokensIn written to the prompt cache (billed at the write premium). */
  readonly cacheWriteTokens: number;
  readonly cacheWrite5mTokens?: number;
  readonly cacheWrite1hTokens?: number;
}

export interface MeteredBody {
  /** The original body, byte-for-byte, with backpressure preserved. */
  readonly body: Readable;
  /** Usage seen so far; final once the body has ended. Undefined if none was found. */
  usage(): Usage | undefined;
  /** True if the stream carried an Anthropic `error` event. */
  sawErrorEvent(): boolean;
  /** `tool_use` blocks in the response; final once the body has ended. */
  toolCalls(): number;
  /** Resolves once metering is over (body fully parsed, or abandoned). Never rejects. */
  readonly settled: Promise<void>;
}

/** Non-streaming bodies above this size are relayed but not parsed for usage. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

interface UsageFields {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation?: {
    ephemeral_5m_input_tokens?: unknown;
    ephemeral_1h_input_tokens?: unknown;
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Taps an Anthropic-format response body (SSE or JSON, possibly compressed) to
 * read its `usage` without changing a single byte the client receives.
 *
 * Telemetry must never break the proxy: every parse failure is swallowed and
 * simply yields `usage() === undefined`.
 */
export function meterAnthropicBody(body: Readable, contentType: string, contentEncoding: string | undefined): MeteredBody {
  let input: number | undefined;
  let output: number | undefined;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cache5m: number | undefined;
  let cache1h: number | undefined;
  let errorEvent = false;
  let seen = false;
  let toolCalls = 0;
  const onToolUse = () => void toolCalls++;

  const absorb = (u: UsageFields | undefined) => {
    if (!u || typeof u !== 'object') return;
    seen = true;
    // message_delta carries cumulative counts; later values win when present.
    input = num(u.input_tokens) ?? input;
    output = num(u.output_tokens) ?? output;
    cacheRead = num(u.cache_read_input_tokens) ?? cacheRead;
    cacheWrite = num(u.cache_creation_input_tokens) ?? cacheWrite;
    cache5m = num(u.cache_creation?.ephemeral_5m_input_tokens) ?? cache5m;
    cache1h = num(u.cache_creation?.ephemeral_1h_input_tokens) ?? cache1h;
  };

  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));

  const sink = contentType.includes('text/event-stream')
    ? sseSink(absorb, () => (errorEvent = true), onToolUse)
    : jsonSink(absorb, onToolUse);
  const decoder = decompressor(contentEncoding);
  let broken = false;
  const finish = () => {
    if (!broken) {
      try {
        sink.end();
      } catch {
        broken = true;
      }
    }
    settle();
  };
  const feed = (chunk: Buffer) => {
    if (broken) return;
    try {
      sink.write(chunk);
    } catch {
      broken = true;
    }
  };
  if (decoder) {
    decoder.on('data', feed);
    decoder.on('end', finish);
    decoder.on('error', () => {
      broken = true;
      settle();
    });
  }

  const tap = new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      if (decoder) decoder.write(chunk);
      else feed(chunk);
      done(null, chunk);
    },
    flush(done: TransformCallback) {
      if (decoder) decoder.end();
      else finish();
      done();
    },
  });
  // pipeline: an upstream error destroys the tap, and a client hang-up
  // (tap destroyed by the server) destroys the upstream body.
  pipeline(body, tap, (err) => {
    if (err) {
      decoder?.destroy();
      settle();
    }
  });

  return {
    body: tap,
    usage: () => {
      if (!seen || (input === undefined && output === undefined)) return undefined;
      const res: Usage = {
        tokensIn: (input ?? 0) + cacheRead + cacheWrite,
        tokensOut: output ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      };
      if (cache5m !== undefined) (res as any).cacheWrite5mTokens = cache5m;
      if (cache1h !== undefined) (res as any).cacheWrite1hTokens = cache1h;
      return res;
    },
    sawErrorEvent: () => errorEvent,
    toolCalls: () => toolCalls,
    settled,
  };
}

interface Sink {
  write(chunk: Buffer): void;
  end(): void;
}

function decompressor(encoding: string | undefined): Gunzip | Transform | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return undefined;
  }
}

/** Line-oriented SSE scan: only `data:` lines that can carry usage, an error or a tool call are JSON-parsed. */
function sseSink(absorb: (u: UsageFields | undefined) => void, onError: () => void, onToolUse: () => void): Sink {
  const text = new StringDecoder('utf8');
  let pending = '';
  const line = (raw: string) => {
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (!data.includes('"usage"') && !data.includes('"error"') && !data.includes('"tool_use"')) return;
    let event: {
      type?: unknown;
      usage?: UsageFields;
      message?: { usage?: UsageFields };
      content_block?: { type?: unknown };
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === 'message_start') absorb(event.message?.usage);
    else if (event.type === 'message_delta') absorb(event.usage);
    else if (event.type === 'error') onError();
    else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') onToolUse();
  };
  const scan = (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) !== -1) {
      line(pending.slice(0, nl).replace(/\r$/, ''));
      pending = pending.slice(nl + 1);
    }
  };
  return {
    write: (chunk) => scan(text.write(chunk)),
    end: () => {
      scan(text.end());
      if (pending) line(pending);
      pending = '';
    },
  };
}

function jsonSink(absorb: (u: UsageFields | undefined) => void, onToolUse: () => void): Sink {
  const parts: Buffer[] = [];
  let size = 0;
  return {
    write: (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) throw new Error('body too large to meter');
      parts.push(chunk);
    },
    end: () => {
      const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as { usage?: UsageFields; content?: unknown };
      absorb(parsed.usage);
      if (Array.isArray(parsed.content)) {
        for (const block of parsed.content) if ((block as { type?: unknown } | null)?.type === 'tool_use') onToolUse();
      }
    },
  };
}
