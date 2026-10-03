import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type TelemetryDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** `drizzle/` ships next to `src/` and `dist/`: one level up from this file's directory. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/**
 * Opens (creating if needed) the telemetry database and applies pending
 * migrations. WAL lets `jev-router stats` read while the proxy is writing.
 */
export function openTelemetryDb(path: string, options: { readonly readonly?: boolean } = {}): TelemetryDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false });
  if (!options.readonly) {
    client.pragma('journal_mode = WAL');
    client.pragma('synchronous = NORMAL');
  }
  client.pragma('busy_timeout = 2000');
  const db = drizzle({ client, schema });
  if (!options.readonly) migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
