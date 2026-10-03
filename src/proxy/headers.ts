import type { IncomingHttpHeaders } from 'node:http';

/** RFC 9110 §7.6.1 hop-by-hop headers + those undici/Node recompute themselves. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export type HeaderMap = Record<string, string | string[]>;

/** Forward everything else verbatim: anthropic-* and x-claude-code-* are open lists. */
export function forwardableHeaders(headers: IncomingHttpHeaders | Record<string, unknown>): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    if (typeof value === 'string' || Array.isArray(value)) out[key] = value as string | string[];
    else out[key] = String(value);
  }
  return out;
}

export function single(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Credential the client presented, from either header Claude Code may use. */
export function presentedCredential(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = single(headers, 'x-api-key');
  if (apiKey) return apiKey;
  const auth = single(headers, 'authorization');
  return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}
