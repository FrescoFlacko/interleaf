import { z } from 'zod';
import { AGENT_MODEL_ID_MAX_LENGTH, AGENT_MODEL_ID_PATTERN, MAX_AGENT_PROFILE_MODELS, MAX_AGENT_PROFILE_MODEL_OPTIONS } from '../constants/agent-models';

export { MAX_AGENT_PROFILE_MODELS, MAX_AGENT_PROFILE_MODEL_OPTIONS };

/**
 * A model identifier that may reach a tokenized argv slot. Kept in its own
 * module so both the profile schema and the settings schema can share it
 * without an import cycle.
 */
export const agentModelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_MODEL_ID_MAX_LENGTH)
  .regex(AGENT_MODEL_ID_PATTERN, 'Model identifiers may not contain spaces, quotes, or leading dashes.');

/** Bounded, de-duplicated per-profile model list persisted in settings. */
export const agentProfileModelsSchema = z
  .array(agentModelIdentifierSchema)
  .max(MAX_AGENT_PROFILE_MODELS)
  .superRefine((models, context) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model)) {
        context.addIssue({ code: 'custom', path: [index], message: 'Model identifiers must be unique.' });
      }
      seen.add(model);
    }
  });
