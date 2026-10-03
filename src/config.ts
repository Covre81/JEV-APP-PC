import { z } from 'zod';
import type { Tier } from './domain/tiers.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const csv = z.string().transform((v) => new Set(v.split(',').map((s) => s.trim()).filter(Boolean)));

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const Env = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    ANTHROPIC_UPSTREAM_URL: z.url().default('https://api.anthropic.com'),
    UPSTREAM_AUTH_MODE: z.enum(['passthrough', 'inject']).default('passthrough'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    PROXY_AUTH_TOKEN: z.string().min(16).optional(),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),

    CLASSIFIER: z.enum(['jev', 'heuristic']).default('jev'),
    TYPESAFE_API_KEY: z.string().min(1).optional(),
    JEV_API_URL: z.url().default('https://api.typesafe.ai/v1/systemone'),
    JEV_MODEL: z.string().default('jev-latest'),
    JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
    CLASSIFIER_MAX_CHARS: z.coerce.number().int().positive().default(4_000),

    ROUTER_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
    ROUTER_ALLOW_ESCALATION: bool.default(true),
    ROUTER_PASSTHROUGH_CLASSES: csv.default(new Set(['auxiliary', 'compaction'])),
    SESSION_TTL_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
    SESSION_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),

    MODEL_HAIKU: z.string().default('claude-haiku-4-5'),
    MODEL_SONNET: z.string().default('claude-sonnet-5-5'),
    MODEL_OPUS: z.string().default('claude-opus-5-5'),
  })
  .superRefine((env, ctx) => {
    if (env.CLASSIFIER === 'jev' && !env.TYPESAFE_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['TYPESAFE_API_KEY'], message: 'required when CLASSIFIER=jev' });
    }
    if (env.UPSTREAM_AUTH_MODE === 'inject' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'required when UPSTREAM_AUTH_MODE=inject' });
    }
    // A key-injecting proxy reachable from the network is an open relay to your bill.
    if (env.UPSTREAM_AUTH_MODE === 'inject' && !LOOPBACK.has(env.HOST) && !env.PROXY_AUTH_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROXY_AUTH_TOKEN'],
        message: 'required when UPSTREAM_AUTH_MODE=inject and HOST is not loopback',
      });
    }
  });

export type Config = Readonly<{
  host: string;
  port: number;
  logLevel: z.infer<typeof Env>['LOG_LEVEL'];
  upstream: Readonly<{
    baseUrl: string;
    authMode: 'passthrough' | 'inject';
    apiKey: string | undefined;
    timeoutMs: number;
  }>;
  proxyAuthToken: string | undefined;
  bodyLimitBytes: number;
  classifier: Readonly<
    | { kind: 'jev'; apiUrl: string; apiKey: string; model: string; timeoutMs: number; maxChars: number }
    | { kind: 'heuristic'; timeoutMs: number; maxChars: number }
  >;
  router: Readonly<{
    threshold: number;
    allowEscalation: boolean;
    passthroughClasses: ReadonlySet<string>;
    sessionTtlMs: number;
    sessionMaxEntries: number;
    models: Readonly<Record<Tier, string>>;
  }>;
}>;

/** Parse once at boot; any misconfiguration kills the process before it listens. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;

  const models: Record<Tier, string> = { haiku: e.MODEL_HAIKU, sonnet: e.MODEL_SONNET, opus: e.MODEL_OPUS };

  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    upstream: {
      baseUrl: e.ANTHROPIC_UPSTREAM_URL.replace(/\/+$/, ''),
      authMode: e.UPSTREAM_AUTH_MODE,
      apiKey: e.ANTHROPIC_API_KEY,
      timeoutMs: e.UPSTREAM_TIMEOUT_MS,
    },
    proxyAuthToken: e.PROXY_AUTH_TOKEN,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    classifier:
      e.CLASSIFIER === 'jev'
        ? {
            kind: 'jev',
            apiUrl: e.JEV_API_URL,
            apiKey: e.TYPESAFE_API_KEY!,
            model: e.JEV_MODEL,
            timeoutMs: e.JEV_TIMEOUT_MS,
            maxChars: e.CLASSIFIER_MAX_CHARS,
          }
        : { kind: 'heuristic', timeoutMs: e.JEV_TIMEOUT_MS, maxChars: e.CLASSIFIER_MAX_CHARS },
    router: {
      threshold: e.ROUTER_THRESHOLD,
      allowEscalation: e.ROUTER_ALLOW_ESCALATION,
      passthroughClasses: e.ROUTER_PASSTHROUGH_CLASSES,
      sessionTtlMs: e.SESSION_TTL_MS,
      sessionMaxEntries: e.SESSION_MAX_ENTRIES,
      models,
    },
  };
}
