import { request, type Dispatcher } from 'undici';
import { forwardableHeaders, type HeaderMap } from '../proxy/headers.js';
import type { Provider, ProviderRequest, ProviderResult } from './provider.js';

export interface AnthropicProviderOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly authMode: 'passthrough' | 'inject';
  readonly apiKey: string | undefined;
  readonly dispatcher?: Dispatcher;
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
    const ac = new AbortController();
    const combinedSignal = AbortSignal.any([req.signal, ac.signal]);
    let timer: NodeJS.Timeout | undefined;

    const reqPromise = request(`${this.options.baseUrl}${req.url}`, {
      method: req.method,
      headers: this.withAuth(req.headers),
      body: req.rawBody ?? null,
      signal: combinedSignal,
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
      ...(this.options.dispatcher ? { dispatcher: this.options.dispatcher } : {})
    });

    let res;
    try {
      res = await Promise.race([
        reqPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new Error('upstream response headers deadline exceeded'));
          }, this.options.timeoutMs);
        }),
      ]);
    } catch (err) {
      reqPromise.then((lateRes) => lateRes.body.destroy()).catch(() => {});
      // The client left: nothing to report. Anything else never reached Anthropic.
      if (req.signal.aborted) throw err;
      return { kind: 'unavailable', reason: `network: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
    return { kind: 'response', status: res.statusCode, headers: forwardableHeaders(res.headers), body: res.body };
  }

  private withAuth(headers: HeaderMap): HeaderMap {
    if (this.options.authMode === 'passthrough') return headers;
    const { authorization: _a, 'x-api-key': _k, ...rest } = headers;
    return { ...rest, 'x-api-key': this.options.apiKey! };
  }
}
