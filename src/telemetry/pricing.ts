import { z } from 'zod';

/** USD per million tokens. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

export interface Pricing {
  /** Anthropic list price for a model id, or undefined when the id is unknown. */
  primary(model: string | null | undefined): ModelPrice | undefined;
  /** Price of the OpenAI-compatible cheap provider (cache reads are not modelled there). */
  readonly cheap: Readonly<{ input: number; output: number }>;
  /** Cache write premium over the base input price (1.25 for the 5-minute TTL). */
  readonly cacheWriteMultiplier: number;
  /** True when the cheap price was left at its $0 default (correct only for local models). */
  readonly cheapPriceUnset: boolean;
  /** Price of the JEV classifier API (TypeSafe), billed per token. */
  readonly jev: Readonly<{ input: number; output: number }>;
  readonly jevPriceUnset: boolean;
}

/**
 * Anthropic first-party list prices, cached from the official model table on
 * 2026-10-08. Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Matched by longest prefix, so dated or suffixed ids
 * (`claude-opus-5-5[1m]`) resolve too. Override with PRIMARY_PRICE_* when
 * your contract differs.
 */
export const ANTHROPIC_PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }], // 0.05x Opus 5.5
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1 }], // 0.05x Sonnet 5.5
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3 }],
  // Haiku 5.5: prompts over 100k cost input 0.50 / output 2.50 / read 0.05. Tiering is not modelled here.
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
];

const SORTED = [...ANTHROPIC_PRICES].sort((a, b) => b[0].length - a[0].length);

export function anthropicListPrice(model: string | null | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  return SORTED.find(([prefix]) => id.startsWith(prefix))?.[1];
}

const usd = z.coerce.number().min(0);

const PricingEnv = z.object({
  CHEAP_PRICE_INPUT_PER_MTOK: usd.optional(),
  CHEAP_PRICE_OUTPUT_PER_MTOK: usd.optional(),
  PRIMARY_PRICE_INPUT_PER_MTOK: usd.optional(),
  PRIMARY_PRICE_OUTPUT_PER_MTOK: usd.optional(),
  PRIMARY_PRICE_CACHE_READ_PER_MTOK: usd.optional(),
  JEV_PRICE_INPUT_PER_MTOK: usd.optional(),
  JEV_PRICE_OUTPUT_PER_MTOK: usd.optional(),
  CACHE_WRITE_MULTIPLIER: z.coerce.number().min(1).default(1.25),
});

export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): Pricing {
  const parsed = PricingEnv.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid pricing configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  const override =
    e.PRIMARY_PRICE_INPUT_PER_MTOK !== undefined && e.PRIMARY_PRICE_OUTPUT_PER_MTOK !== undefined
      ? {
          input: e.PRIMARY_PRICE_INPUT_PER_MTOK,
          output: e.PRIMARY_PRICE_OUTPUT_PER_MTOK,
          cacheRead: e.PRIMARY_PRICE_CACHE_READ_PER_MTOK ?? e.PRIMARY_PRICE_INPUT_PER_MTOK * 0.1,
        }
      : undefined;
  return {
    primary: (model) => override ?? anthropicListPrice(model),
    cheap: { input: e.CHEAP_PRICE_INPUT_PER_MTOK ?? 0, output: e.CHEAP_PRICE_OUTPUT_PER_MTOK ?? 0 },
    cacheWriteMultiplier: e.CACHE_WRITE_MULTIPLIER,
    cheapPriceUnset: e.CHEAP_PRICE_INPUT_PER_MTOK === undefined && e.CHEAP_PRICE_OUTPUT_PER_MTOK === undefined,
    jev: { input: e.JEV_PRICE_INPUT_PER_MTOK ?? 0, output: e.JEV_PRICE_OUTPUT_PER_MTOK ?? 0 },
    jevPriceUnset: e.JEV_PRICE_INPUT_PER_MTOK === undefined && e.JEV_PRICE_OUTPUT_PER_MTOK === undefined,
  };
}
