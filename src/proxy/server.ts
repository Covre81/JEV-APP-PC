import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Dispatcher } from 'undici';
import type { Config } from '../config.js';
import { profileFor } from '../domain/model-catalog.js';
import { parseMessagesBody } from '../routing/messages-body.js';
import { adaptForModel } from '../routing/request-adapter.js';
import type { RouteDecision, Router } from '../routing/router.js';
import { forwardableHeaders, presentedCredential, single } from './headers.js';
import { relayableHeaders, type Upstream } from './upstream.js';

export interface ServerDeps {
  readonly config: Config;
  readonly router: Router;
  readonly upstream: Upstream;
}

/**
 * Statuses on which a *rewritten* request is replayed verbatim on the model the
 * client asked for: the cheaper model rejected something in the body
 * (unsupported field/beta, prompt too long, model not enabled for this key).
 * Safe to replay because nothing has been streamed to the client yet.
 */
const REPLAY_ON_REQUESTED_MODEL = new Set([400, 404, 422]);

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer({ config, router, upstream }: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.bodyLimitBytes,
    exposeHeadRoutes: false,
  });

  // Keep every body as raw bytes: untouched requests are forwarded byte-for-byte.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const proxyToken = config.upstream.authMode === 'inject' ? config.proxyAuthToken : undefined;
  if (proxyToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/healthz') return;
      const presented = presentedCredential(req.headers);
      if (!presented || !sameSecret(presented, proxyToken)) {
        return reply.code(401).send(anthropicError('authentication_error', 'invalid proxy token'));
      }
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/v1/messages', (req, reply) => handleMessages(req, reply, true));
  app.post('/v1/messages/count_tokens', (req, reply) => handleMessages(req, reply, false));
  // Everything else (/v1/models, HEAD /api/hello, …) is a transparent pass-through.
  app.all('*', (req, reply) => forward(req, reply, rawBody(req)));

  async function handleMessages(req: FastifyRequest, reply: FastifyReply, mayClassify: boolean) {
    const raw = rawBody(req);
    const body = raw ? parseMessagesBody(raw) : undefined;
    // Unparseable → let Anthropic return its canonical validation error.
    if (!raw || !body) return forward(req, reply, raw);

    const decision = await router.decide({
      body,
      rawByteLength: raw.length,
      sessionId: single(req.headers, 'x-claude-code-session-id'),
      agentId: single(req.headers, 'x-claude-code-agent-id'),
      requestClass: single(req.headers, 'x-claude-code-request-class'),
      contextCompacted: single(req.headers, 'x-claude-code-context-compacted') !== undefined,
      mayClassify,
    });
    req.log.info({ route: decision }, 'route decision');

    if (decision.model === body.model) return forward(req, reply, raw, decision);

    const adapted = adaptForModel(body, decision.model, profileFor(decision.model));
    return forward(req, reply, Buffer.from(JSON.stringify(adapted)), decision, raw);
  }

  async function forward(
    req: FastifyRequest,
    reply: FastifyReply,
    body: Buffer | undefined,
    decision?: RouteDecision,
    originalBody?: Buffer,
  ) {
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });

    const send = (payload: Buffer | undefined) =>
      upstream.send({
        method: req.method as Dispatcher.HttpMethod,
        url: req.url,
        headers: forwardableHeaders(req.headers),
        body: payload,
        signal: controller.signal,
      });

    try {
      let res = await send(body);
      let effective = decision;

      if (originalBody && decision && REPLAY_ON_REQUESTED_MODEL.has(res.statusCode)) {
        req.log.warn(
          { status: res.statusCode, routedModel: decision.model, requestedModel: decision.requestedModel },
          'routed request rejected upstream; replaying on requested model',
        );
        await res.body.dump();
        router.pinToRequested(decision);
        res = await send(originalBody);
        effective = { ...decision, model: decision.requestedModel, reason: 'fallback:upstream-rejected' };
      }

      reply.code(res.statusCode).headers(relayableHeaders(res));
      if (effective) reply.header('x-jev-route', `${effective.model}; reason=${effective.reason}`);
      return reply.send(res.body);
    } catch (err) {
      if (controller.signal.aborted) return reply; // client went away; nothing to answer
      req.log.error({ err }, 'upstream request failed');
      return reply.code(502).send(anthropicError('api_error', 'jev-router: upstream unreachable'));
    }
  }

  return app;
}

function rawBody(req: FastifyRequest): Buffer | undefined {
  return Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
}
