import type { TelemetryDb } from './db.js';
import { INSERT_ROUTER_LOG, insertParams, type NewRouterLog } from './schema.js';

/** Port: where routing telemetry goes. `record` must never block or throw. */
export interface TelemetrySink {
  record(entry: NewRouterLog): void;
  /** Flushes what is queued; called on shutdown. */
  close(): Promise<void>;
}

export const noopTelemetry: TelemetrySink = {
  record: () => {},
  close: async () => {},
};

export interface SqliteTelemetryOptions {
  /** How long rows may sit in memory before a batch write. */
  readonly flushIntervalMs?: number;
  /** Rows kept in memory if the database keeps failing; the oldest are dropped beyond this. */
  readonly maxQueued?: number;
  readonly onError?: (err: unknown) => void;
}

/**
 * Fire-and-forget SQLite sink.
 *
 * better-sqlite3 is synchronous, so writing inline would put disk I/O on the
 * event loop of the request being answered. Instead `record` only pushes to an
 * in-memory queue; a timer (unref'd, so it never keeps the process alive)
 * writes the queue in one transaction. One fsync per batch instead of per row.
 */
export class SqliteTelemetry implements TelemetrySink {
  private queue: NewRouterLog[] = [];
  private readonly timer: NodeJS.Timeout;
  private readonly maxQueued: number;
  private readonly onError: (err: unknown) => void;
  private closed = false;

  constructor(
    private readonly db: TelemetryDb,
    options: SqliteTelemetryOptions = {},
  ) {
    this.maxQueued = options.maxQueued ?? 10_000;
    this.onError = options.onError ?? (() => {});
    this.timer = setInterval(() => this.flush(), options.flushIntervalMs ?? 1_000);
    this.timer.unref();
  }

  record(entry: NewRouterLog): void {
    if (this.closed) return;
    this.queue.push(entry);
    if (this.queue.length > this.maxQueued) this.queue.splice(0, this.queue.length - this.maxQueued);
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      const insert = this.db.prepare(INSERT_ROUTER_LOG);
      this.db.transaction(() => {
        for (const row of batch) insert.run(insertParams(row));
      })();
    } catch (err) {
      // Keep the rows for the next tick (disk full, database locked, …).
      this.queue = batch.concat(this.queue).slice(-this.maxQueued);
      this.onError(err);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.flush();
    this.db.close();
  }
}
