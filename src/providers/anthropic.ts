import { request } from 'undici';
import { forwardableHeaders, type HeaderMap } from '../proxy/headers.js';
import type { Provider, ProviderRequest, ProviderResult } from './provider.js';

export interface AnthropicProviderOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly authMode: 'passthrough' | 'inject';
  readonly apiKey: string | undefined;
}

/**
 * Primary provider: a byte-level forwarder. No parsing, no decompression, no
 * buffering — SSE events, pings, error bodies and rate-limit headers reach
 * the client exactly as Anthropic sent them (Claude Code depends on all four).
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  constructor(private readonly options: AnthropicProviderOptions) {}

  async send(req: ProviderRequest): Promise<ProviderResult> {
    const res = await request(`${this.options.baseUrl}${req.url}`, {
      method: req.method,
      headers: this.withAuth(req.headers),
      body: req.rawBody ?? null,
      signal: req.signal,
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
    });
    return { kind: 'response', status: res.statusCode, headers: forwardableHeaders(res.headers), body: res.body };
  }

  private withAuth(headers: HeaderMap): HeaderMap {
    if (this.options.authMode === 'passthrough') return headers;
    const { authorization: _a, 'x-api-key': _k, ...rest } = headers;
    return { ...rest, 'x-api-key': this.options.apiKey! };
  }
}
