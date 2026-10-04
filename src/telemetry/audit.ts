import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { RouteDecision } from '../routing/router.js';
import type { TelemetrySink } from './recorder.js';
import type { JevDecision, Outcome } from './schema.js';
import { meterAnthropicBody, type MeteredBody } from './usage-meter.js';

/** What the server knows about an exchange before the upstream answers. */
export interface ExchangeContext {
  readonly startedAt: number;
  readonly startedAtMs: number;
  readonly humanText: string | undefined;
  readonly requestClass: string | undefined;
  readonly model: string | undefined;
  readonly requestedModel: string | undefined;
}

export interface UpstreamOutcome {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[]>>;
  readonly body: Readable;
}

/** Upper bound on waiting for a compressed body's usage to finish decoding. */
const SETTLE_TIMEOUT_MS = 5_000;

const header = (h: UpstreamOutcome['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export function promptHash(text: string | undefined): string | null {
  return text === undefined ? null : createHash('sha256').update(text).digest('hex');
}

export function jevDecisionOf(decision: RouteDecision): JevDecision | null {
  const d = decision.distribution;
  if (!d) return null;
  return {
    simple: d.simple,
    standard: d.standard,
    structural: d.structural,
    pSimple: d.simple,
    pComplex: d.structural,
    classifierMs: decision.classifierMs ?? null,
  };
}

/**
 * Wraps the upstream body so its usage can be read, and records one row once
 * the client connection closes. Recording is deferred off the response path:
 * nothing here can delay or fail the bytes the client receives.
 */
export function auditExchange(
  sink: TelemetrySink,
  res: ServerResponse,
  upstream: UpstreamOutcome,
  decision: RouteDecision,
  ctx: ExchangeContext,
  onError: (err: unknown) => void,
): Readable {
  let metered: MeteredBody;
  try {
    metered = meterAnthropicBody(
      upstream.body,
      header(upstream.headers, 'content-type') ?? '',
      header(upstream.headers, 'content-encoding'),
    );
  } catch (err) {
    onError(err);
    return upstream.body;
  }

  res.once('close', () => {
    const latencyMs = Math.round(performance.now() - ctx.startedAt);
    const delivered = res.writableFinished;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS).unref());
    void Promise.race([metered.settled, timeout]).then(() => {
      try {
        const outcome: Outcome = !delivered
          ? 'client_abort'
          : upstream.status >= 400
            ? 'http_error'
            : metered.sawErrorEvent()
              ? 'stream_error'
              : 'ok';
        record(sink, decision, ctx, { status: upstream.status, outcome, latencyMs, usage: metered.usage() });
      } catch (err) {
        onError(err);
      }
    });
  });
  return metered.body;
}

/** For exchanges that never got an upstream body (jev-router answered 502 itself). */
export function auditFailure(sink: TelemetrySink, decision: RouteDecision, ctx: ExchangeContext): void {
  record(sink, decision, ctx, {
    status: 502,
    outcome: 'proxy_error',
    latencyMs: Math.round(performance.now() - ctx.startedAt),
    usage: undefined,
  });
}

function record(
  sink: TelemetrySink,
  decision: RouteDecision,
  ctx: ExchangeContext,
  result: {
    status: number;
    outcome: Outcome;
    latencyMs: number;
    usage: ReturnType<MeteredBody['usage']>;
  },
): void {
  sink.record({
    createdAt: new Date(ctx.startedAtMs),
    sessionId: decision.conversationKey ?? null,
    humanPromptHash: promptHash(ctx.humanText),
    jevDecision: jevDecisionOf(decision),
    finalProvider: decision.route === 'cheap' ? 'openai' : 'anthropic',
    model: ctx.model ?? null,
    requestedModel: ctx.requestedModel ?? null,
    routeReason: decision.reason,
    requestClass: ctx.requestClass ?? null,
    httpStatus: result.status,
    outcome: result.outcome,
    tokensIn: result.usage?.tokensIn ?? null,
    tokensOut: result.usage?.tokensOut ?? null,
    cacheReadTokens: result.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
    latencyMs: result.latencyMs,
    fallbackTriggered: decision.reason === 'failover:cheap-unavailable',
  });
}
