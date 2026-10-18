import type { PortableValue } from '../models/portable';

import type { AgentProviderId } from '../types/agent';
import { agentModelCandidates } from './agent-model-candidates';

/** Bounded runtime limit already enforced by the CLI adapters' argv guard. */
export const AGENT_MODEL_ID_MAX_LENGTH = 128;

/** Upper bound on the per-profile model list a user may persist in settings. */
export const MAX_AGENT_PROFILE_MODELS = 16;

/**
 * Upper bound on a catalog a main-owned listing probe may contribute
 * (`src/main/agents/model-discovery.ts`). It lives here because it is one of
 * the terms of the projection bound below.
 */
export const MAX_DISCOVERED_AGENT_MODELS = 64;

/**
 * Conservative identifier shape for a model value that may reach a tokenized
 * argv slot. It deliberately excludes whitespace, quotes, shell metacharacters,
 * and leading dashes so a stored or requested value can never be mistaken for
 * an additional CLI flag.
 */
export const AGENT_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u;

export function isAgentModelIdentifier(value: PortableValue): value is string {
  return typeof value === 'string' && AGENT_MODEL_ID_PATTERN.test(value);
}

/**
 * Repo-evidenced seed identifiers only.
 *
 * Interleaf does not ship a live agent-CLI model catalog: `docs/CLI_CAPABILITIES.md`
 * §3 records each CLI's `--model` *flag* surface, and §7 requires model facts to
 * be probed at runtime rather than asserted from memory. The single directly
 * CLI-valid identifier the repository owns is `claude --model claude-opus-5`
 * (`docs/agents/MODEL_ROUTING.md`), so that is the only production seed. Every
 * other provider's options come from the user's own bounded per-profile list in
 * Settings, which is why this table must never grow into an unevidenced catalog.
 *
 * `fake` is the deterministic test/development seam and is never selectable in a
 * normal launch (`AgentService.isFakeAllowed`).
 */
const SEEDED_PROVIDER_MODELS: Readonly<Record<AgentProviderId, readonly string[]>> = {
  codex: [],
  'claude-code': ['claude-opus-5'],
  antigravity: [],
  copilot: [],
  opencode: [],
  pi: [],
  cursor: [],
  custom: [],
  fake: ['fixture-model-a', 'fixture-model-b'],
};

export function seededAgentModels(providerId: AgentProviderId): readonly string[] {
  return SEEDED_PROVIDER_MODELS[providerId];
}

const MAX_SEEDED_PROVIDER_MODELS = Math.max(
  ...Object.values(SEEDED_PROVIDER_MODELS).map((models) => models.length)
);

/**
 * Upper bound on a projected `AgentProfile.availableModels` list.
 *
 * It is the sum of every source `resolveAgentModelOptions` merges — the
 * profile's default, the user's persisted list, a discovered catalog, and the
 * repo-evidenced seeds — because deduplication can only shorten the result.
 * The typed contract, the IPC schema and this resolver must agree on it: a
 * bound smaller than what discovery can legitimately produce would reject a
 * valid profile at the process boundary instead of bounding anything.
 */
export const MAX_AGENT_PROFILE_MODEL_OPTIONS =
  1 + MAX_AGENT_PROFILE_MODELS + MAX_DISCOVERED_AGENT_MODELS + MAX_SEEDED_PROVIDER_MODELS;

export type AgentModelResolutionInput = {
  readonly providerId: AgentProviderId;
  readonly modelSelection: boolean;
  /** The profile's configured default (built-in settings or custom config). */
  readonly defaultModel: string | null;
  /** The user's bounded per-profile list persisted in settings. */
  readonly configuredModels?: readonly string[] | undefined;
  /**
   * Identifiers the installed CLI itself reported, from a main-owned bounded
   * listing probe (`src/main/agents/model-discovery.ts`). Runtime-only: never
   * persisted, and absent whenever the provider has no listing mechanism or the
   * probe did not answer, which leaves the provider default in place.
   */
  readonly discoveredModels?: readonly string[] | undefined;
};

/**
 * The single source of truth for "which models may this profile run".
 *
 * Both the renderer projection (`toRendererAgentProfile`) and the main-process
 * start-request guard call this, so the renderer can only ever offer the exact
 * set main will accept. Order is deterministic — configured default first, then
 * the user's list, then what the installed CLI reported, then repo-evidenced
 * seeds — and non-conforming values are dropped rather than silently forwarded
 * into argv. The user's own entries stay ahead of discovery so an automatic
 * catalog never reorders a list someone curated.
 */
export function resolveAgentModelOptions(input: AgentModelResolutionInput): readonly string[] {
  if (!input.modelSelection) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const candidates = agentModelCandidates(
    input.defaultModel,
    input.configuredModels,
    input.discoveredModels,
    seededAgentModels(input.providerId)
  );
  for (const candidate of candidates) {
    if (!isAgentModelIdentifier(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered;
}
