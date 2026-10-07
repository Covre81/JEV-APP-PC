import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Dispatcher } from 'undici';
import type { BuildInfo } from '../build-info.js';
import type { Config } from '../config.js';
import type { Route } from '../domain/policy.js';
import type { CheapState } from '../providers/cheap-health.js';
import type { Provider, ProviderRequest, ProviderResult } from '../providers/provider.js';
import { latestHumanText, parseMessagesBody, type MessagesBody } from '../routing/messages-body.js';
import type { RouteDecision, Router } from '../routing/router.js';
import { auditExchange, auditFailure, type ExchangeContext } from '../telemetry/audit.js';
import { noopTelemetry, type TelemetrySink } from '../telemetry/recorder.js';
import { forwardableHeaders, presentedCredential, single } from './headers.js';

export interface ServerDeps {
  readonly config: Config;
  readonly router: Router;
  /** `standard` serves the standard tier; without it that tier falls back to `cheap`. */
  readonly providers: Readonly<Record<Route, Provider>> & { readonly standard?: Provider };
  readonly telemetry?: TelemetrySink;
  /** Live cheap-provider health; absent = never checked ('unknown'). */
  readonly cheapHealth?: { readonly state: CheapState };
  /** The build this process runs; absent when running from src. */
  readonly build?: BuildInfo;
}

/** Primary statuses that mean "no quota/capacity right now" (opt-in failover to cheap). */
const PRIMARY_RATE_LIMITED = new Set([429, 529]);

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer({
  config,
  router,
  providers,
  telemetry = noopTelemetry,
  cheapHealth,
  build,
}: ServerDeps): FastifyInstance {
  const startedAt = new Date().toISOString();
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.bodyLimitBytes,
    exposeHeadRoutes: false,
  });

  // Keep every body as raw bytes: primary-bound requests are forwarded byte-for-byte.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const proxyToken = config.primary.authMode === 'inject' ? config.proxyAuthToken : undefined;
  if (proxyToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/healthz') return;
      const presented = presentedCredential(req.headers);
      if (!presented || !sameSecret(presented, proxyToken)) {
        return reply.code(401).send(anthropicError('authentication_error', 'invalid proxy token'));
      }
    });
  }

  // Which build answers: a merge that was built but never reloaded shows up here and in the status line.
  app.get('/healthz', async () => ({
    ok: true,
    sha: build?.sha ?? null,
    builtAt: build?.builtAt ?? null,
    startedAt,
    pid: process.pid,
    cheap: cheapHealth?.state ?? 'unknown',
  }));
  app.post('/v1/messages', handleMessages);
  // count_tokens, /v1/models, HEAD /api/hello, … are Anthropic concerns: pass through.
  app.all('*', async (req, reply) => relay(reply, await providers.primary.send(providerRequest(req, reply))));

  async function handleMessages(req: FastifyRequest, reply: FastifyReply) {
    const startedAt = performance.now();
    const startedAtMs = Date.now();
    const base = providerRequest(req, reply);
    // Unparseable → let Anthropic return its canonical validation error.
    if (!base.body || !base.rawBody) return relay(reply, await providers.primary.send(base));

    const decision = await router.decide({
      body: base.body,
      rawByteLength: base.rawBody.length,
      sessionId: single(req.headers, 'x-claude-code-session-id'),
      agentId: single(req.headers, 'x-claude-code-agent-id'),
      requestClass: single(req.headers, 'x-claude-code-request-class'),
      contextCompacted: single(req.headers, 'x-claude-code-context-compacted') !== undefined,
    });

    const standard = decision.tier === 'standard' && providers.standard !== undefined;
    const cheapProvider = standard ? providers.standard! : providers.cheap;
    const cheapModel = standard ? (config.cheapStandard?.model ?? config.cheap.model) : config.cheap.model;
    const exchange = (route: Route): ExchangeContext => ({
      startedAt,
      startedAtMs,
      humanText: latestHumanText(base.body!),
      requestClass: single(req.headers, 'x-claude-code-request-class'),
      model: route === 'primary' ? base.body!.model : cheapModel,
      requestedModel: base.body!.model,
      toolsOffered: Array.isArray(base.body!['tools']) ? base.body!['tools'].length : 0,
    });

    // A provider known to be down costs a failed attempt per turn: skip it, and do not
    // pin the conversation, so it returns to cheap once the provider is back.
    if (decision.route === 'cheap' && cheapHealth?.state === 'down') {
      const skipped: RouteDecision = { ...decision, route: 'primary', reason: 'skipped:cheap-unhealthy' };
      return relay(reply, await providers.primary.send(base), skipped, req, exchange('primary'));
    }

    if (decision.route === 'cheap') {
      const cheap = await cheapProvider.send({ ...base, onStreamFailure: () => router.pinToPrimary(decision) });
      if (cheap.kind === 'response') return relay(reply, cheap, decision, req, exchange('cheap'));

      router.pinToPrimary(decision);
      const failover: RouteDecision = { ...decision, route: 'primary', reason: 'failover:cheap-unavailable' };
      req.log.warn({ reason: cheap.reason, conversation: decision.conversationKey }, 'cheap provider unavailable');
      return relay(reply, await providers.primary.send(base), failover, req, exchange('primary'));
    }

    const primary = await providers.primary.send(base);
    if (
      primary.kind === 'unavailable' ||
      !config.router.failoverOnPrimaryRateLimit ||
      !PRIMARY_RATE_LIMITED.has(primary.status)
    ) {
      return relay(reply, primary, decision, req, exchange('primary'));
    }

    // Quota failover: hold the (small) error body so it can still be relayed
    // verbatim if the cheap provider cannot take the request either.
    const errorBody = Buffer.concat(await primary.body.toArray());
    const cheap = await providers.cheap.send(base);
    if (cheap.kind === 'response') {
      return relay(
        reply,
        cheap,
        { ...decision, route: 'cheap', reason: 'failover:primary-rate-limited' },
        req,
        exchange('cheap'),
      );
    }
    const original: ProviderResult = { ...primary, body: Readable.from([errorBody]) };
    return relay(reply, original, decision, req, exchange('primary'));
  }

  function providerRequest(req: FastifyRequest, reply: FastifyReply): ProviderRequest {
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
    const body: MessagesBody | undefined = rawBody && req.url.startsWith('/v1/messages') ? parseMessagesBody(rawBody) : undefined;
    return {
      method: req.method as Dispatcher.HttpMethod,
      url: req.url,
      headers: forwardableHeaders(req.headers),
      rawBody,
      body,
      signal: controller.signal,
    };
  }

  function relay(
    reply: FastifyReply,
    result: ProviderResult,
    decision?: RouteDecision,
    req?: FastifyRequest,
    exchange?: ExchangeContext,
  ) {
    const audited = decision && exchange;
    if (result.kind === 'unavailable') {
      if (audited) auditFailure(telemetry, decision, exchange);
      return reply.code(502).send(anthropicError('api_error', `jev-router: ${result.reason}`));
    }
    if (decision) {
      req?.log.info({ route: decision }, 'route decision');
      reply.header('x-jev-route', `${decision.route}; reason=${decision.reason}`);
    }
    reply.code(result.status).headers(result.headers);
    const body = audited
      ? auditExchange(telemetry, reply.raw, result, decision, exchange, (err) =>
          reply.log.warn({ err }, 'telemetry failed'),
        )
      : result.body;
    return reply.send(body);
  }

  app.setErrorHandler((err, req, reply) => {
    if (reply.raw.destroyed) return; // client went away mid-request
    // Fastify's own 4xx (body too large, bad content type) are the client's problem, not the upstream's.
    const status = (err as unknown as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const message = (err as unknown as { message?: string }).message || 'request error';
      return reply.code(status).send(anthropicError(status === 413 ? 'request_too_large' : 'invalid_request_error', message));
    }
    req.log.error({ err }, 'request failed');
    return reply.code(502).send(anthropicError('api_error', 'jev-router: upstream unreachable'));
  });

  return app;
}
