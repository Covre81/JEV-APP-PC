import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-user home of a globally installed jev-router: `.env` and the telemetry
 * database live here so the CLI behaves the same from any directory.
 * Override with JEV_ROUTER_HOME.
 */
export function jevHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['JEV_ROUTER_HOME'] || join(homedir(), '.jev-router');
}

export function defaultTelemetryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(jevHome(env), 'telemetry.db');
}
