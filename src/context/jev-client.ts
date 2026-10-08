import { request } from 'undici';
import type { z } from 'zod';

/** Non-200 from JEV. The message carries the status and the API's reason, never the request echoed back. */
export class JevHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'JevHttpError';
  }
}

/** A 200 answer that does not match the shape the caller relies on. */
export class JevSchemaError extends Error {
  override readonly name = 'JevSchemaError';
}

export interface JevClientOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
}

/**
 * The reason of a JEV error body, without the `input` a validation error
 * echoes (it repeats the request, prompt included). FastAPI-style
 * `{detail: [{loc, msg}]}` becomes `questions.x.criteria: Field required`.
 */
export function jevErrorReason(payload: unknown): string {
  const p = payload as { detail?: unknown; error?: { message?: unknown }; message?: unknown } | null;
  if (Array.isArray(p?.detail)) {
    return p.detail
      .slice(0, 3)
      .map((d: { loc?: unknown; msg?: unknown }) => {
        const loc = Array.isArray(d.loc) ? d.loc.filter((part) => part !== 'body').join('.') : '';
        return `${loc ? `${loc}: ` : ''}${String(d.msg ?? 'invalid')}`;
      })
      .join('; ');
  }
  if (typeof p?.detail === 'string') return p.detail.slice(0, 200);
  if (typeof p?.error?.message === 'string') return p.error.message.slice(0, 200);
  if (typeof p?.message === 'string') return p.message.slice(0, 200);
  return 'unexpected response';
}

/** Parses a JEV answer, turning a mismatch into a short `schema: path: message`. */
export function parseJev<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new JevSchemaError(`schema: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`);
}

export class JevClient {
  constructor(private readonly options: JevClientOptions) {}

  async postSystemOne(body: object, signal: AbortSignal): Promise<unknown> {
    const res = await request(this.options.apiUrl, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    let payload: unknown;
    try {
      payload = await res.body.json();
    } catch {
      payload = undefined;
    }
    if (res.statusCode !== 200) throw new JevHttpError(res.statusCode, `JEV HTTP ${res.statusCode}: ${jevErrorReason(payload)}`);
    if (payload === undefined) throw new JevSchemaError('schema: (root): response is not JSON');
    return payload;
  }
}
