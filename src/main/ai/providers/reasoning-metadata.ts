/**
 * Per-model reasoning metadata, read from what each provider itself publishes.
 *
 * Every input here is untrusted external data — CLI listings, catalog JSON,
 * local server replies — so each reader is bounded, keeps only vocabulary
 * members its provider's transport documents, and answers `null` (Default only)
 * for anything missing, malformed or empty. Nothing is inferred from a model's
 * name: a level is offered only where the provider listed it for that model.
 */
import { canonicalReasoningLevels } from '@shared/constants/reasoning';
import type { AIModelReasoning, ReasoningEffort } from '@shared/types/ai';
import { type PortableMember, type PortableRecord, isPortableArray, isPortableRecord } from '@shared/models/portable';

/** Entries read from one advertised level list; longer lists are not trusted. */
const MAX_ADVERTISED_LEVELS = 16;
/** Longest single advertised level token. */
const MAX_LEVEL_LENGTH = 16;

const CODEX_LEVELS: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const OMP_LEVELS: ReadonlySet<string> = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** OpenRouter's documented `reasoning.effort` values. */
export const OPENROUTER_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OPENROUTER_LEVELS: ReadonlySet<string> = new Set(OPENROUTER_EFFORTS);
/** Named Ollama `think` levels; `on`/`off` come only from boolean values. */
const OLLAMA_NAMED_LEVELS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** The canonical level set, or `null` when nothing usable was advertised. */
function reasoningFromLevels(levels: Iterable<string>, allowed: ReadonlySet<string>): AIModelReasoning | null {
  const offered = canonicalReasoningLevels([...levels].filter((level) => allowed.has(level)));
  return offered.length === 0 ? null : { levels: [...offered] };
}

/** Bounded string members of an advertised list, or `null` if it is not a list. */
function advertisedStrings(value: PortableMember): readonly string[] | null {
  if (!isPortableArray(value)) return null;
  return value
    .slice(0, MAX_ADVERTISED_LEVELS)
    .filter((entry): entry is string => typeof entry === 'string' && entry.length <= MAX_LEVEL_LENGTH);
}

/**
 * Codex `model/list` entry: `supportedReasoningEfforts[].reasoningEffort`.
 * `ultra` (sub-agent delegation) is outside the vocabulary and never offered.
 */
export function codexEntryReasoning(entry: PortableRecord): AIModelReasoning | null {
  const efforts = entry.supportedReasoningEfforts;
  if (!isPortableArray(efforts)) return null;
  const levels = efforts.slice(0, MAX_ADVERTISED_LEVELS).map((effort) => {
    const value = isPortableRecord(effort) ? effort.reasoningEffort : undefined;
    return typeof value === 'string' && value.length <= MAX_LEVEL_LENGTH ? value : '';
  });
  return reasoningFromLevels(levels, CODEX_LEVELS);
}

/** Claude `list_models` entry: `supportsEffort` plus `supportedEffortLevels`. */
export function claudeEntryReasoning(entry: PortableRecord): AIModelReasoning | null {
  if (entry.supportsEffort !== true) return null;
  return reasoningFromLevels(advertisedStrings(entry.supportedEffortLevels) ?? [], CLAUDE_LEVELS);
}

/** Omp `models --json` entry: `thinking: string[] | null`; `auto` is never offered. */
export function ompEntryReasoning(entry: PortableRecord): AIModelReasoning | null {
  if (entry.reasoning !== true) return null;
  return reasoningFromLevels(advertisedStrings(entry.thinking) ?? [], OMP_LEVELS);
}

const PI_BASE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
const PI_OPT_IN_LEVELS = ['xhigh', 'max'] as const;

/**
 * Pi RPC model: Pi's own supported-level rule. A model without reasoning offers
 * only `off`; otherwise the base levels minus any its `thinkingLevelMap` maps
 * to `null`, plus `xhigh`/`max` only where the map defines them. A map that is
 * present but not an object is malformed and offers nothing.
 */
export function piEntryReasoning(entry: PortableRecord): AIModelReasoning | null {
  if (entry.reasoning === false) return { levels: ['off'] };
  if (entry.reasoning !== true) return null;
  const map = entry.thinkingLevelMap;
  if (map !== undefined && !isPortableRecord(map)) return null;
  const mapped = (level: string): PortableMember => (map === undefined ? undefined : map[level]);
  const levels: string[] = PI_BASE_LEVELS.filter((level) => mapped(level) !== null);
  for (const level of PI_OPT_IN_LEVELS) {
    const target = mapped(level);
    if (target !== undefined && target !== null) levels.push(level);
  }
  return reasoningFromLevels(levels, OMP_LEVELS);
}

/**
 * OpenRouter catalog `reasoning`. `null` or absent offers no control; an object
 * whose `supported_efforts` is omitted offers none either; an explicit `null`
 * list means every gateway effort; an array means exactly its valid members.
 * A mandatory-reasoning model never offers `none`.
 */
export function openRouterReasoning(value: PortableMember): AIModelReasoning | null {
  if (!isPortableRecord(value) || !('supported_efforts' in value)) return null;
  const supported = value.supported_efforts;
  const advertised = supported === null ? OPENROUTER_EFFORTS : advertisedStrings(supported);
  if (advertised === null) return null;
  const levels = value.mandatory === true ? advertised.filter((level) => level !== 'none') : advertised;
  return reasoningFromLevels(levels, OPENROUTER_LEVELS);
}

/**
 * Ollama `/api/show` `thinking.values`: named levels as advertised, or a
 * boolean pair presented as On/Off. A model whose only value is `false` cannot
 * think at all and offers no control.
 */
export function ollamaThinkingReasoning(value: PortableMember): AIModelReasoning | null {
  if (!isPortableRecord(value) || !isPortableArray(value.values)) return null;
  const levels: string[] = [];
  for (const entry of value.values.slice(0, MAX_ADVERTISED_LEVELS)) {
    if (entry === true) levels.push('on');
    else if (entry === false) levels.push('off');
    else if (typeof entry === 'string' && OLLAMA_NAMED_LEVELS.has(entry)) levels.push(entry);
  }
  if (!levels.some((level) => level !== 'off')) return null;
  return reasoningFromLevels(levels, new Set([...OLLAMA_NAMED_LEVELS, 'on', 'off']));
}
