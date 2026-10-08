export type CheapState = 'unknown' | 'up' | 'down';

export interface CheapHealthOptions {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly intervalMs: number;
  /** Per-probe timeout. */
  readonly timeoutMs?: number;
  /** Called when the state changes (logging). */
  readonly onChange?: (state: CheapState) => void;
}

/**
 * Polls `GET {baseUrl}/models` so a dead cheap provider stops costing one
 * failed attempt per cheap turn. `unknown` (before the first answer) still
 * lets the router try: the health check may only remove attempts, never add
 * a failure mode.
 *
 * ponytail: Ollama's /models proves the daemon is up, not that ollama.com
 * answers for a *-cloud model. If that false positive shows up, probe with a
 * 1-token completion instead.
 */
export class CheapHealth {
  state: CheapState = 'unknown';
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: CheapHealthOptions) {}

  async check(): Promise<CheapState> {
    let next: CheapState;
    try {
      const res = await fetch(`${this.options.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3_000),
      });
      await res.body?.cancel();
      next = res.ok ? 'up' : 'down';
    } catch {
      next = 'down';
    }
    if (next !== this.state) this.options.onChange?.(next);
    this.state = next;
    return next;
  }

  /** First probe, waiting at most `bootWaitMs` (boot must not hang on a dead provider), then poll. */
  async start(bootWaitMs = 2_000): Promise<void> {
    await Promise.race([this.check(), new Promise((r) => setTimeout(r, bootWaitMs).unref())]);
    this.timer = setInterval(() => void this.check(), this.options.intervalMs).unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
