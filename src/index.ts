import type { ComplexityClassifier } from './classifier/classifier.js';
import { HeuristicClassifier } from './classifier/heuristic-classifier.js';
import { JevClassifier } from './classifier/jev-classifier.js';
import { loadConfig } from './config.js';
import type { Route } from './domain/policy.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatibleProvider } from './providers/openai/provider.js';
import { buildServer } from './proxy/server.js';
import { Router } from './routing/router.js';
import { TtlLruStore } from './routing/session-store.js';

// Composition root: the only place that knows concrete implementations.
const config = loadConfig();

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
  new TtlLruStore<Route>(config.router.sessionMaxEntries, config.router.sessionTtlMs),
  {
    policy: { minCheapProbability: config.router.minCheapProbability, standardRoute: config.router.standardRoute },
    allowEscalation: config.router.allowEscalation,
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

const app = buildServer({ config, router, providers });

await app.listen({ host: config.host, port: config.port });
app.log.info(
  {
    classifier: classifier.name,
    primary: config.primary.baseUrl,
    cheap: `${config.cheap.baseUrl} (${config.cheap.model})`,
  },
  'jev-router ready',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
