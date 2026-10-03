import type { ModelProfile } from '../domain/model-catalog.js';
import type { MessagesBody } from './messages-body.js';

/**
 * Rewrites a Messages request for a different target model.
 *
 * Touches ONLY `model` and the fields the target would reject. `system`,
 * `tools` and `messages` are never modified: rewriting them breaks prompt
 * caching and preserved-thinking checks upstream.
 */
export function adaptForModel(body: MessagesBody, targetModel: string, profile: ModelProfile): MessagesBody {
  const adapted: MessagesBody = { ...body, model: targetModel };

  if (adapted.max_tokens !== undefined && adapted.max_tokens > profile.maxOutputTokens) {
    adapted.max_tokens = profile.maxOutputTokens;
  }

  if (!profile.adaptiveThinking && adapted.thinking?.type === 'adaptive') {
    delete adapted.thinking;
  }

  if (!profile.effort && adapted.output_config && 'effort' in adapted.output_config) {
    const { effort: _dropped, ...rest } = adapted.output_config;
    if (Object.keys(rest).length > 0) adapted.output_config = rest;
    else delete adapted.output_config;
  }

  if (!profile.fastMode && adapted.speed !== undefined) {
    delete adapted.speed;
  }

  return adapted;
}
