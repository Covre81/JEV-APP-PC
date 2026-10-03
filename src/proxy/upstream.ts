import { request, type Dispatcher } from 'undici';
import { forwardableHeaders, type HeaderMap } from './headers.js';

export interface UpstreamOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly authMode: 'passthrough' | 'inject';
  readonly apiKey: string | undefined;
}

export interface UpstreamRequest {
  readonly method: Dispatcher.HttpMethod;
  /** Path + query exactly as received (e.g. `/v1/messages?beta=true`). */
  readonly url: string;
  readonly headers: HeaderMap;
  readonly body: Buffer | undefined;
  readonly signal: AbortSignal;
}

export type UpstreamResponse = Dispatcher.ResponseData;

/**
 * Byte-level forwarder. No parsing, no decompression, no buffering of the
 * response: SSE events and keep-alive pings reach the client as they arrive.
 */
export class Upstream {
  constructor(private readonly options: UpstreamOptions) {}

  send(req: UpstreamRequest): Promise<UpstreamResponse> {
    const headers = this.withAuth(req.headers);
    return request(`${this.options.baseUrl}${req.url}`, {
      method: req.method,
      headers,
      body: req.body ?? null,
      signal: req.signal,
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
    });
  }

  private withAuth(headers: HeaderMap): HeaderMap {
    if (this.options.authMode === 'passthrough') return headers;
    const { authorization: _a, 'x-api-key': _k, ...rest } = headers;
    return { ...rest, 'x-api-key': this.options.apiKey! };
  }
}

/** Response headers to relay to the client (retry-after, ratelimit, x-should-retry, …). */
export function relayableHeaders(res: UpstreamResponse): HeaderMap {
  return forwardableHeaders(res.headers);
}
