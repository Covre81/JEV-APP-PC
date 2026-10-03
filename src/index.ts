import { HeuristicClassifier } from './classifier/heuristic-classifier.js';
import { JevClassifier } from './classifier/jev-classifier.js';
import type { ComplexityClassifier } from './classifier/classifier.js';
import { loadConfig } from './config.js';
import type { Tier } from './domain/tiers.js';
import { buildServer } from './proxy/server.js';
import { Upstream } from './proxy/upstream.js';
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
  new TtlLruStore<Tier>(config.router.sessionMaxEntries, config.router.sessionTtlMs),
  {
    threshold: config.router.threshold,
    allowEscalation: config.router.allowEscalation,
    passthroughClasses: config.router.passthroughClasses,
    models: config.router.models,
    classifierTimeoutMs: config.classifier.timeoutMs,
    classifierMaxChars: config.classifier.maxChars,
  },
);

const app = buildServer({ config, router, upstream: new Upstream(config.upstream) });

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { classifier: classifier.name, upstream: config.upstream.baseUrl, models: config.router.models },
  'jev-router ready',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
