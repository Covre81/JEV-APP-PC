import { request } from 'undici';

export class JevHttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'JevHttpError';
  }
}

export interface JevClientOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
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

    const payload: unknown = await res.body.json();
    if (res.statusCode !== 200) {
      throw new JevHttpError(res.statusCode, `JEV HTTP ${res.statusCode}: ${JSON.stringify(payload).slice(0, 300)}`);
    }

    return payload;
  }
}
