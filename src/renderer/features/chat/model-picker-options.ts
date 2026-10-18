import type { AIModelInfo, AIModelReasoning, AIProviderId, AIProviderStatus } from '@shared/types/ai';
import { displayProviderName } from './chat-labels';
import { modelsInDisplayOrder } from './model-order';
import { buildModelOptions } from './openrouter-model-options';
import type { OpenRouterCatalogState } from './use-openrouter-catalog';

const OPENROUTER_AUTO = 'openrouter/auto';

/** One choosable provider-and-model pair in the composer's model picker. */
export type PickerRow = {
  /** Stable DOM-safe key; the pair itself is carried separately and exactly. */
  readonly key: string;
  readonly providerId: AIProviderId;
  readonly modelId: string;
  readonly name: string;
  /** The exact id, shown in mono when the name does not already restate it. */
  readonly detail: string | null;
  /** Listed so a saved or configured id keeps its label; it cannot be chosen. */
  readonly unavailable: boolean;
  /**
   * The levels main published for this exact model, or `null` when it offers
   * none — such a row is chosen directly and has no submenu.
   */
  readonly reasoning: AIModelReasoning | null;
};

export type PickerGroup = {
  readonly providerId: AIProviderId;
  readonly label: string;
  readonly rows: readonly PickerRow[];
};

/** What the picker knows about OpenRouter's catalog, all of it from main. */
export type OpenRouterPickerSource = {
  readonly state: OpenRouterCatalogState;
  readonly models: readonly AIModelInfo[];
  /** Settings' persisted model, which main runs for an `openrouter/auto` binding. */
  readonly configuredModel: string | null;
};

/** Strips case and punctuation so `gpt-5.1-codex` and `GPT-5.1 Codex` compare equal. */
function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A DOM-safe key that stays distinct for distinct ids: every character outside
 * `[A-Za-z0-9-]`, `_` included, becomes `_<hex>_`, so `a/b` and `a_b` differ.
 */
function rowKey(providerId: AIProviderId, modelId: string): string {
  const encoded = modelId.replace(/[^A-Za-z0-9-]/gu, (char) => `_${(char.codePointAt(0) ?? 0).toString(16)}_`);
  return `${providerId}_${encoded}`;
}

/** A configured non-Auto model is what main sends for an Auto binding. */
function configuredOverride(source: OpenRouterPickerSource): string | null {
  const configured = source.configuredModel;
  return configured !== null && configured !== OPENROUTER_AUTO ? configured : null;
}

function makeRow(providerId: AIProviderId, model: AIModelInfo, unavailable: boolean): PickerRow {
  const sameAsName = normalized(model.name) === normalized(model.id);
  const sentinel = model.id.endsWith('-default');
  return {
    key: rowKey(providerId, model.id),
    providerId,
    modelId: model.id,
    name: model.name,
    detail: sameAsName || sentinel ? null : model.id,
    unavailable,
    reasoning: unavailable || model.reasoning === undefined || model.reasoning.levels.length === 0 ? null : model.reasoning,
  };
}

/**
 * OpenRouter's rows: Auto, the catalog main last listed, and the bound and
 * configured ids. Nothing is called unavailable until the newest listing has
 * actually answered — while it loads or after it fails, that is not known.
 */
export function openRouterRows(source: OpenRouterPickerSource, boundModelId: string | null): readonly PickerRow[] {
  const override = configuredOverride(source);
  const autoName = override === null ? 'OpenRouter Auto' : 'Settings default';
  const ready = source.state === 'ready';
  const options = buildModelOptions({
    catalogModels: source.models,
    configuredModel: override ?? '',
    draftModel: boundModelId ?? '',
  });
  return options.map((option) => {
    if (option.id === OPENROUTER_AUTO) {
      // Auto is resolved to a model only when a turn runs, so no level can be
      // offered against it here.
      return { ...makeRow('openrouter', option, false), name: autoName, detail: override ?? OPENROUTER_AUTO, reasoning: null };
    }
    return makeRow('openrouter', option, ready && option.legacy);
  });
}

/** One group per ready provider, in the order main reports them. */
export function pickerGroups(
  readyProviders: readonly AIProviderStatus[],
  openRouter: OpenRouterPickerSource,
  bound: { readonly providerId: AIProviderId; readonly modelId: string | null }
): readonly PickerGroup[] {
  return readyProviders.map((provider) => ({
    providerId: provider.id,
    label: displayProviderName(provider.id, provider.name),
    rows:
      provider.id === 'openrouter'
        ? openRouterRows(openRouter, bound.providerId === 'openrouter' ? bound.modelId : null)
        : modelsInDisplayOrder(provider.models).map((model) => makeRow(provider.id, model, false)),
  }));
}

/**
 * Every whitespace-separated term must appear in the provider's name or id, or
 * in the model's name or id. Plain substring matching keeps the result
 * explainable: what was typed is visibly in what is listed.
 */
export function filterGroups(groups: readonly PickerGroup[], query: string): readonly PickerGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => {
        const haystack = [group.label, group.providerId, row.name, row.modelId].join(' ').toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }),
    }))
    .filter((group) => group.rows.length > 0);
}

/** The rows a keyboard walks, in display order. */
export function flatRows(groups: readonly PickerGroup[]): readonly PickerRow[] {
  return groups.flatMap((group) => group.rows);
}

export type PickerTriggerLabel = {
  readonly model: string;
  /**
   * The start of `model` that repeats the provider's name, as in the
   * `OpenRouter ` of `OpenRouter Auto`; empty when there is none. A trigger too
   * narrow for the whole name drops it, since the provider is named elsewhere.
   */
  readonly lead: string;
  /** Omitted when the model name already names the provider, so it reads once. */
  readonly provider: string | null;
};

/**
 * What the trigger says about the binding. Only main's own data is used — the
 * provider's published models, the catalog main listed, the configured
 * OpenRouter model — and an id nothing names is shown exactly as it is.
 */
export function triggerLabel(input: {
  readonly providerId: AIProviderId;
  readonly providerInfo: AIProviderStatus | undefined;
  readonly modelId: string | null;
  readonly openRouter: OpenRouterPickerSource;
}): PickerTriggerLabel {
  const provider = input.providerInfo
    ? displayProviderName(input.providerId, input.providerInfo.name)
    : `${displayProviderName(input.providerId, null)} (status unavailable)`;
  const model = modelName(input);
  // A provider main has not reported is always named, with that caveat.
  const restates = input.providerInfo !== undefined &&
    normalized(model).includes(normalized(displayProviderName(input.providerId, null)));
  return { model, lead: providerLead(input.providerId, model), provider: restates ? null : provider };
}

/** `Claude ` for `Claude Opus 5.5` under Claude Code; never the whole name. */
function providerLead(providerId: AIProviderId, model: string): string {
  const lead = `${displayProviderName(providerId, null).split(' ')[0] ?? ''} `;
  const repeats = lead.length > 1 && model.length > lead.length && model.toLowerCase().startsWith(lead.toLowerCase());
  return repeats ? model.slice(0, lead.length) : '';
}

function modelName(input: Parameters<typeof triggerLabel>[0]): string {
  const { providerId, modelId, openRouter } = input;
  if (providerId === 'openrouter' && (modelId === null || modelId === OPENROUTER_AUTO)) {
    return configuredOverride(openRouter) === null ? 'OpenRouter Auto' : 'Settings default';
  }
  if (modelId === null) return `${displayProviderName(providerId, input.providerInfo?.name)} default`;
  const known = [...(input.providerInfo?.models ?? []), ...(providerId === 'openrouter' ? openRouter.models : [])];
  return known.find((model) => model.id === modelId)?.name ?? modelId;
}
