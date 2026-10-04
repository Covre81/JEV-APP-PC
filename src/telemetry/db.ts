import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

export type TelemetryDb = DatabaseSync;

/**
 * Opens (creating if needed) the telemetry database and applies pending
 * migrations. WAL lets `jev-router stats` read while the proxy is writing.
 *
 * node:sqlite ships with Node, so there is no native module to install or
 * compile. On Node 22 and 24 it still prints an ExperimentalWarning once.
 */
export function openTelemetryDb(path: string, options: { readonly readonly?: boolean } = {}): TelemetryDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  // readOnly opens without SQLITE_OPEN_CREATE, so a missing file throws instead of being created.
  const db = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  db.exec('PRAGMA busy_timeout = 2000');
  if (options.readonly) return db;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

/** Runs fn inside BEGIN/COMMIT, rolling back if it throws. */
export function inTransaction(db: TelemetryDb, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function userVersion(db: TelemetryDb): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function migrate(db: TelemetryDb): void {
  let applied = userVersion(db);
  if (applied >= MIGRATIONS.length) return;
  // ponytail: drizzle bridge. Databases created under drizzle count their migrations in
  // __drizzle_migrations instead. Delete once every telemetry.db has been opened by this
  // version (it sets user_version, so the bridge never runs twice on the same file).
  if (applied === 0 && db.prepare(`SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'`).get()) {
    applied = (db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
  }
  inTransaction(db, () => {
    for (const sql of MIGRATIONS.slice(applied)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });
}
