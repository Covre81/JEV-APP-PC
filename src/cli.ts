#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { defaultTelemetryDbPath } from './paths.js';

const USAGE = `Usage: jev-router [command] [options]

Commands:
  serve            Start the gateway (default)
  stats            Print routing and token-savings statistics from the telemetry database
  statusline       One line for Claude Code's statusLine: router health and this session's last route
  help             Show this message

Options:
  --env <file>     Env file to load (default: ./.env, else ~/.jev-router/.env)
  --db <file>      stats: telemetry database (default: TELEMETRY_DB_PATH or ~/.jev-router/telemetry.db)
  --since <span>   stats: only the last <n>h / <n>d / <n>m (e.g. 24h, 7d)
  --json           stats: machine-readable output

Variables already set in the shell win over the env file.`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: 'string' },
      db: { type: 'string' },
      since: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0] ?? 'serve';
  if (values.help || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  loadEnv(values.env);

  switch (command) {
    case 'serve': {
      const { serve } = await import('./serve.js');
      await serve(loadConfig());
      return -1; // keep running
    }
    case 'stats': {
      // stats must work without provider keys: read only what it needs.
      const dbPath = values.db ?? process.env['TELEMETRY_DB_PATH'] ?? defaultTelemetryDbPath();
      if (!existsSync(dbPath)) {
        console.error(`No telemetry database at ${dbPath}. Start the gateway with \`jev-router serve\` first.`);
        return 1;
      }
      const [{ openTelemetryDb }, { computeStats, parseSince, renderStats }, { pricingFromEnv }] = await Promise.all([
        import('./telemetry/db.js'),
        import('./telemetry/stats.js'),
        import('./telemetry/pricing.js'),
      ]);
      // Writable on purpose: applies pending migrations if the gateway has not run since an upgrade.
      const db = openTelemetryDb(dbPath);
      try {
        const stats = computeStats(db, {
          ...(values.since ? { since: parseSince(values.since) } : {}),
          pricing: pricingFromEnv(),
        });
        console.log(values.json ? JSON.stringify(stats, null, 2) : renderStats(stats));
      } finally {
        db.close();
      }
      return 0;
    }
    case 'statusline': {
      const { readSessionId, statusLine } = await import('./statusline.js');
      const sessionId = await readSessionId();
      const line = await statusLine({
        dbPath: values.db ?? process.env['TELEMETRY_DB_PATH'] ?? defaultTelemetryDbPath(),
        healthUrl: `http://${process.env['HOST'] || '127.0.0.1'}:${process.env['PORT'] || '8787'}/healthz`,
        ...(sessionId ? { sessionId } : {}),
      });
      // Exit once written: a stdin that never closed must not keep the status line hanging.
      process.stdout.write(`${line}\n`, () => process.exit(0));
      return -1;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
