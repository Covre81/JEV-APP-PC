import { z } from 'zod';
import type { Route } from './domain/policy.js';

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

    CHEAP_BASE_URL: z.url().default('https://api.groq.com/openai/v1'),
    CHEAP_API_KEY: z.string().min(1),
    CHEAP_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
    CHEAP_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8_192),
    CHEAP_CONTEXT_TOKENS: z.coerce.number().int().positive().default(131_072),
    CHEAP_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

    ROUTER_MIN_CHEAP_PROBABILITY: z.coerce.number().min(0).max(1).default(0.8),
    ROUTER_STANDARD_ROUTE: z.enum(['primary', 'cheap']).default('primary'),
    ROUTER_ALLOW_ESCALATION: bool.default(true),
    ROUTER_PRIMARY_CLASSES: csv.default(new Set(['auxiliary', 'compaction'])),
    FAILOVER_ON_PRIMARY_RATE_LIMIT: bool.default(false),
    SESSION_TTL_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
    SESSION_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),
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
  primary: Readonly<{
    baseUrl: string;
    authMode: 'passthrough' | 'inject';
    apiKey: string | undefined;
    timeoutMs: number;
  }>;
  cheap: Readonly<{
    baseUrl: string;
    apiKey: string;
    model: string;
    maxOutputTokens: number;
    contextTokens: number;
    timeoutMs: number;
  }>;
  proxyAuthToken: string | undefined;
  bodyLimitBytes: number;
  classifier: Readonly<
    | { kind: 'jev'; apiUrl: string; apiKey: string; model: string; timeoutMs: number; maxChars: number }
    | { kind: 'heuristic'; timeoutMs: number; maxChars: number }
  >;
  router: Readonly<{
    minCheapProbability: number;
    standardRoute: Route;
    allowEscalation: boolean;
    primaryClasses: ReadonlySet<string>;
    failoverOnPrimaryRateLimit: boolean;
    sessionTtlMs: number;
    sessionMaxEntries: number;
  }>;
}>;

/** Parse once at boot; any misconfiguration kills the process before it listens. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const trimSlash = (url: string) => url.replace(/\/+$/, '');

  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    primary: {
      baseUrl: trimSlash(e.ANTHROPIC_UPSTREAM_URL),
      authMode: e.UPSTREAM_AUTH_MODE,
      apiKey: e.ANTHROPIC_API_KEY,
      timeoutMs: e.UPSTREAM_TIMEOUT_MS,
    },
    cheap: {
      baseUrl: trimSlash(e.CHEAP_BASE_URL),
      apiKey: e.CHEAP_API_KEY,
      model: e.CHEAP_MODEL,
      maxOutputTokens: e.CHEAP_MAX_OUTPUT_TOKENS,
      contextTokens: e.CHEAP_CONTEXT_TOKENS,
      timeoutMs: e.CHEAP_TIMEOUT_MS,
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
      minCheapProbability: e.ROUTER_MIN_CHEAP_PROBABILITY,
      standardRoute: e.ROUTER_STANDARD_ROUTE,
      allowEscalation: e.ROUTER_ALLOW_ESCALATION,
      primaryClasses: e.ROUTER_PRIMARY_CLASSES,
      failoverOnPrimaryRateLimit: e.FAILOVER_ON_PRIMARY_RATE_LIMIT,
      sessionTtlMs: e.SESSION_TTL_MS,
      sessionMaxEntries: e.SESSION_MAX_ENTRIES,
    },
  };
}
