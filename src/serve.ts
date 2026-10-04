import type { ComplexityClassifier } from './classifier/classifier.js';
import { HeuristicClassifier } from './classifier/heuristic-classifier.js';
import { JevClassifier } from './classifier/jev-classifier.js';
import type { Config } from './config.js';
import type { Route } from './domain/policy.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatibleProvider } from './providers/openai/provider.js';
import { buildServer } from './proxy/server.js';
import { Router } from './routing/router.js';
import { TtlLruStore } from './routing/session-store.js';
import { openTelemetryDb } from './telemetry/db.js';
import { noopTelemetry, SqliteTelemetry, type TelemetrySink } from './telemetry/recorder.js';

// ponytail: fixed cap, one entry per live conversation. An evicted cheap
// conversation is treated as unknown and goes primary: savings lost, never
// correctness. Raise it only if `stats` shows that under heavy parallel use.
const SESSION_MAX_ENTRIES = 10_000;

/** Composition root: the only place that knows concrete implementations. */
export async function serve(config: Config): Promise<void> {
  const classifier: ComplexityClassifier =
    config.classifier.kind === 'jev'
      ? new JevClassifier({
          apiUrl: config.classifier.apiUrl,
          apiKey: config.classifier.apiKey,
          model: config.classifier.model,
        })
      : new HeuristicClassifier();

  const router = new Router(
    classifier,
    new TtlLruStore<Route>(SESSION_MAX_ENTRIES, config.router.sessionTtlMs),
    {
      policy: { minCheapProbability: config.router.minCheapProbability, standardRoute: config.router.standardRoute },
      primaryClasses: config.router.primaryClasses,
      // Input budget: 90% of the window, minus the output tokens we reserve.
      cheapContextTokens: Math.floor(config.cheap.contextTokens * 0.9) - config.cheap.maxOutputTokens,
      classifierTimeoutMs: config.classifier.timeoutMs,
      classifierMaxChars: config.classifier.maxChars,
    },
  );

  const providers = {
    primary: new AnthropicProvider(config.primary),
    cheap: new OpenAICompatibleProvider(config.cheap),
  };

  // Errors surface through the server's logger, which exists only after buildServer.
  let logTelemetryError: (err: unknown) => void = () => {};
  const telemetry: TelemetrySink = config.telemetry.dbPath
    ? new SqliteTelemetry(openTelemetryDb(config.telemetry.dbPath), { onError: (err) => logTelemetryError(err) })
    : noopTelemetry;

  const app = buildServer({ config, router, providers, telemetry });
  logTelemetryError = (err) => app.log.error({ err }, 'telemetry write failed');
  app.addHook('onClose', () => telemetry.close());

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      classifier: classifier.name,
      primary: config.primary.baseUrl,
      cheap: `${config.cheap.baseUrl} (${config.cheap.model})`,
      telemetry: config.telemetry.dbPath ?? 'disabled',
    },
    'jev-router ready',
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
