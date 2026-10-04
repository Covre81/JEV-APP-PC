import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

export type TelemetryDb = Database.Database;

/**
 * Opens (creating if needed) the telemetry database and applies pending
 * migrations. WAL lets `jev-router stats` read while the proxy is writing.
 */
export function openTelemetryDb(path: string, options: { readonly readonly?: boolean } = {}): TelemetryDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false });
  db.pragma('busy_timeout = 2000');
  if (options.readonly) return db;
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: TelemetryDb): void {
  let applied = db.pragma('user_version', { simple: true }) as number;
  if (applied >= MIGRATIONS.length) return;
  // ponytail: drizzle bridge. Databases created under drizzle count their migrations in
  // __drizzle_migrations instead. Delete once every telemetry.db has been opened by this
  // version (it sets user_version, so the bridge never runs twice on the same file).
  if (applied === 0 && db.prepare(`SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'`).get()) {
    applied = (db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
  }
  db.transaction(() => {
    for (const sql of MIGRATIONS.slice(applied)) db.exec(sql);
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
}
