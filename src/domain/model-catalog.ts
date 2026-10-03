import type { Tier } from './tiers.js';

/**
 * What a target model accepts. Used only when the router *changes* the model,
 * to strip request fields the cheaper model would reject with a 400.
 *
 * Source: Anthropic model docs (cached 2026-09). Unknown models get the
 * permissive profile and rely on the proxy's 400 → original-model fallback.
 */
export interface ModelProfile {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Accepts `thinking: { type: "adaptive" }`. */
  readonly adaptiveThinking: boolean;
  /** Accepts `output_config.effort`. */
  readonly effort: boolean;
  /** Accepts `speed: "fast"`. */
  readonly fastMode: boolean;
}

const FRONTIER: ModelProfile = {
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  adaptiveThinking: true,
  effort: true,
  fastMode: false,
};

const PROFILES: Readonly<Record<string, ModelProfile>> = {
  'claude-haiku-4-5': {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    adaptiveThinking: false,
    effort: false,
    fastMode: false,
  },
  'claude-sonnet-4-6': FRONTIER,
  'claude-sonnet-5': FRONTIER,
  'claude-sonnet-5-5': FRONTIER,
  'claude-opus-4-6': FRONTIER,
  'claude-opus-4-7': FRONTIER,
  'claude-opus-4-8': { ...FRONTIER, fastMode: true },
  'claude-opus-5': { ...FRONTIER, fastMode: true },
  'claude-opus-5-5': { ...FRONTIER, fastMode: true },
  'claude-fable-5': FRONTIER,
  'claude-fable-5-1': FRONTIER,
};

export function profileFor(modelId: string): ModelProfile {
  return PROFILES[modelId] ?? FRONTIER;
}

/**
 * Infers the capability tier of a model ID the client sent.
 * Fable/Mythos sit in the top tier: the router may route *down* from them,
 * never sideways to a different top-tier model.
 */
export function tierOfModel(modelId: string): Tier | undefined {
  const id = modelId.toLowerCase();
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus') || id.includes('fable') || id.includes('mythos')) return 'opus';
  return undefined;
}
