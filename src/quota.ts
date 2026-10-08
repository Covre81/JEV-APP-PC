/**
 * Claude quota as Anthropic reports it on every response. With a claude.ai
 * login: `anthropic-ratelimit-unified-<window>-{utilization,status,reset}`
 * (5h, 7d, …) plus overall `-unified-status`. With an API key:
 * `anthropic-ratelimit-{requests,tokens,…}-{limit,remaining,reset}`.
 *
 * [INFERIDO] header names come from public sources and the API-key scheme;
 * validate against one real response (log only the anthropic-ratelimit-* names).
 */

export interface QuotaWindow {
  readonly name: string;
  /** 0..1 share of the window used. */
  readonly utilization: number;
  readonly status?: string;
  readonly resetAt?: Date;
}

export interface QuotaReading {
  readonly windows: readonly QuotaWindow[];
  /** Overall `anthropic-ratelimit-unified-status`. */
  readonly status?: string;
}

export type QuotaLevel = 'none' | 'pressure' | 'critical';

export interface QuotaLevels {
  readonly pressure: number;
  readonly critical: number;
}

/** What the router and the status line act on: the window closest to its limit. */
export interface QuotaSnapshot {
  readonly utilization: number;
  readonly window: string;
  readonly status?: string;
  readonly resetAt?: Date;
  readonly observedAt: Date;
}

const FULL = new Set(['rate_limited', 'rejected', 'exceeded']);
const UNIFIED = /^anthropic-ratelimit-unified-(.+)-(utilization|status|reset)$/;
const API_KEY = /^anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-(limit|remaining|reset)$/;

type Headers = Readonly<Record<string, string | string[] | number | undefined>>;

const first = (v: Headers[string]): string | undefined => (Array.isArray(v) ? v[0] : v === undefined ? undefined : String(v));

/** Epoch seconds or RFC 3339. */
function parseReset(raw: string): Date | undefined {
  const asNumber = Number(raw);
  const d = Number.isFinite(asNumber) && raw.trim() !== '' ? new Date(asNumber * 1000) : new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseQuotaHeaders(headers: Headers): QuotaReading {
  const windows = new Map<
    string,
    { utilization?: number; status?: string; resetAt?: Date | undefined; limit?: number; remaining?: number }
  >();
  const slot = (name: string) => windows.get(name) ?? (windows.set(name, {}), windows.get(name)!);
  let status: string | undefined;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const value = first(rawValue);
    if (value === undefined) continue;
    if (name === 'anthropic-ratelimit-unified-status') {
      status = value;
      continue;
    }
    const unified = UNIFIED.exec(name);
    if (unified) {
      const [, window, field] = unified as unknown as [string, string, string];
      if (window === 'overage') continue; // overage billing state, not a usage window
      const w = slot(window);
      if (field === 'utilization') {
        const u = Number(value);
        // ponytail: assumes a 0..1 fraction; a value past 1.5 is read as a percentage.
        if (Number.isFinite(u)) w.utilization = u > 1.5 ? u / 100 : u;
      } else if (field === 'status') w.status = value;
      else w.resetAt = parseReset(value);
      continue;
    }
    const apiKey = API_KEY.exec(name);
    if (apiKey) {
      const [, kind, field] = apiKey as unknown as [string, string, string];
      const w = slot(kind);
      if (field === 'reset') w.resetAt = parseReset(value);
      else if (Number.isFinite(Number(value))) w[field as 'limit' | 'remaining'] = Number(value);
    }
  }

  const out: QuotaWindow[] = [];
  for (const [name, w] of windows) {
    let utilization = w.utilization;
    if (utilization === undefined && w.limit && w.remaining !== undefined) utilization = 1 - w.remaining / w.limit;
    if (w.status && FULL.has(w.status)) utilization = 1;
    if (utilization === undefined) continue;
    out.push({
      name,
      utilization: Math.min(1, Math.max(0, Math.round(utilization * 10_000) / 10_000)),
      ...(w.status ? { status: w.status } : {}),
      ...(w.resetAt ? { resetAt: w.resetAt } : {}),
    });
  }
  return { windows: out, ...(status ? { status } : {}) };
}

/** The binding window: the highest utilization across windows. */
export function bindingUtilization(q: QuotaReading): { utilization: number; window: string } | undefined {
  let best: QuotaWindow | undefined;
  for (const w of q.windows) if (!best || w.utilization > best.utilization) best = w;
  return best ? { utilization: best.utilization, window: best.name } : undefined;
}

export function quotaLevel(utilization: number | undefined, levels: QuotaLevels): QuotaLevel {
  if (utilization === undefined) return 'none';
  if (utilization >= levels.critical) return 'critical';
  return utilization >= levels.pressure ? 'pressure' : 'none';
}

/**
 * Latest quota seen on an Anthropic response. A response without rate-limit
 * headers (count_tokens, an error from the proxy) keeps the last reading.
 * `onChange` fires on a move of at least 0.01 or a status change: what is
 * worth persisting for the status line, which runs in another process.
 */
export class QuotaStore {
  private snapshot: QuotaSnapshot | undefined;

  constructor(
    private readonly levels: QuotaLevels,
    private readonly onChange: (s: QuotaSnapshot) => void = () => {},
  ) {}

  observe(headers: Headers): void {
    const reading = parseQuotaHeaders(headers);
    const binding = bindingUtilization(reading);
    if (!binding) return;
    const window = reading.windows.find((w) => w.name === binding.window);
    const next: QuotaSnapshot = {
      utilization: binding.utilization,
      window: binding.window,
      ...(reading.status ? { status: reading.status } : {}),
      ...(window?.resetAt ? { resetAt: window.resetAt } : {}),
      observedAt: new Date(),
    };
    const prev = this.snapshot;
    this.snapshot = next;
    if (!prev || Math.abs(next.utilization - prev.utilization) >= 0.01 || next.status !== prev.status || next.window !== prev.window) {
      this.onChange(next);
    }
  }

  current(): QuotaSnapshot | undefined {
    return this.snapshot;
  }

  level(): QuotaLevel {
    return quotaLevel(this.snapshot?.utilization, this.levels);
  }
}
