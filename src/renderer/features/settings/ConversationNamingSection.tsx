import { useEffect, useState, type ReactElement } from 'react';
import { AI_PROVIDER_IDS, aiProviderDisplayName } from '@shared/constants/ai';
import type { AppSettings } from '@shared/schemas/settings';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import { Select } from '../../components/ui/select';
import type { SelectOption } from '../../components/ui/select-model';
import { isProviderReady } from '../../stores/use-chat-store';
import { buildModelOptions } from '../chat/openrouter-model-options';
import { SettingsSectionHeader } from '../../components/ui/settings-section-header';
import { useOpenRouterCatalog } from '../chat/use-openrouter-catalog';

type NamingMode = AppSettings['ai']['conversationNaming'];
type NamingProviderId = Exclude<NamingMode, 'auto' | null>['providerId'];

function isNamingProviderId(value: string): value is NamingProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export type ConversationNamingSectionProps = {
  readonly settings: AppSettings;
  readonly onSettingsChange: (next: AppSettings) => void;
  readonly providers: readonly AIProviderStatus[];
  /** Whether the live provider probe has answered; until then nothing is offered. */
  readonly providersReady: boolean;
  readonly settingsReady: boolean;
};

const OFF = '';
const AUTO = 'auto';

/** The models a provider offers for naming, plus a saved one it no longer lists. */
function modelOptions(
  providerId: NamingProviderId,
  status: AIProviderStatus | undefined,
  catalog: readonly AIModelInfo[],
  savedModel: string | null
): SelectOption[] {
  if (providerId === 'openrouter') {
    return buildModelOptions({ catalogModels: catalog, configuredModel: savedModel ?? '', draftModel: '' })
      .map((model) => ({ value: model.id, label: model.legacy ? `${model.name} (unavailable)` : model.name }));
  }
  const listed = (status?.models ?? []).map((model) => ({ value: model.id, label: model.name }));
  if (savedModel !== null && !listed.some((option) => option.value === savedModel)) {
    listed.push({ value: savedModel, label: `${savedModel} (unavailable)` });
  }
  return listed;
}

/**
 * How new Reader Chat conversations are named (docs/AI_ARCHITECTURE.md):
 * Automatic (a small model from the conversation's own provider, the default),
 * an explicit provider and model, or Off.
 *
 * Only providers ready for Reader Chat are offered. A saved choice whose
 * provider or model is no longer available stays shown, marked unavailable, so
 * it can be changed or turned off; it is never silently replaced. Choosing a
 * provider only drafts it: nothing is saved until a model is chosen. Main
 * re-verifies the choice before every naming call.
 */
export function ConversationNamingSection(props: ConversationNamingSectionProps): ReactElement {
  const saved = props.settings.ai.conversationNaming;
  const explicit = saved === null || saved === AUTO ? null : saved;
  const [draftProvider, setDraftProvider] = useState<NamingProviderId | null>(null);
  const catalog = useOpenRouterCatalog();
  const providerId = draftProvider ?? explicit?.providerId ?? null;
  const fetchCatalog = catalog.fetch;
  const catalogIdle = catalog.state === 'idle';
  useEffect(() => {
    if (providerId === 'openrouter' && catalogIdle) void fetchCatalog();
  }, [providerId, catalogIdle, fetchCatalog]);

  const ready = props.providersReady ? props.providers.filter(isProviderReady) : [];
  const modeOptions: SelectOption[] = [
    { value: AUTO, label: 'Automatic' },
    { value: OFF, label: 'Off' },
    ...ready.map((status) => ({ value: status.id, label: aiProviderDisplayName(status.id, status.name) })),
  ];
  if (providerId !== null && !ready.some((status) => status.id === providerId)) {
    modeOptions.push({ value: providerId, label: `${aiProviderDisplayName(providerId)} (unavailable)` });
  }
  const savedModel = explicit?.providerId === providerId ? explicit.modelId : null;
  const models = providerId === null
    ? []
    : modelOptions(providerId, props.providers.find((status) => status.id === providerId), catalog.models, savedModel);

  const commit = (mode: NamingMode): void => {
    props.onSettingsChange({ ...props.settings, ai: { ...props.settings.ai, conversationNaming: mode } });
  };
  const chooseMode = (value: string): void => {
    if (value === OFF || value === AUTO) {
      setDraftProvider(null);
      const mode = value === AUTO ? AUTO : null;
      if (saved !== mode) commit(mode);
      return;
    }
    if (!isNamingProviderId(value)) return;
    setDraftProvider(explicit?.providerId === value ? null : value);
  };
  const chooseModel = (modelId: string): void => {
    if (providerId === null || modelId === OFF) return;
    setDraftProvider(null);
    commit({ providerId, modelId });
  };

  return (
    <section aria-labelledby="conversation-naming-title" data-testid="conversation-naming-section" className="mt-8">
      <SettingsSectionHeader
        id="conversation-naming-title"
        title="Conversation naming"
        description="New Reader Chat conversations are titled after their first answer. An excerpt of the first question is sent to the naming provider, and any usage is charged under that provider."
      />
      <div className="settings-field">
        <label htmlFor="conversation-naming-provider" className="settings-field-label">Naming provider</label>
        <Select
          id="conversation-naming-provider"
          data-testid="conversation-naming-provider"
          value={providerId ?? (saved === null ? OFF : AUTO)}
          disabled={!props.settingsReady}
          options={modeOptions}
          onValueChange={chooseMode}
          aria-describedby="conversation-naming-note"
        />
      </div>
      {providerId !== null && (
        <div className="settings-field">
          <label htmlFor="conversation-naming-model" className="settings-field-label">Naming model</label>
          <Select
            id="conversation-naming-model"
            data-testid="conversation-naming-model"
            value={savedModel ?? OFF}
            placeholder="Choose a model"
            disabled={!props.settingsReady || models.length === 0}
            options={models}
            onValueChange={chooseModel}
            aria-describedby="conversation-naming-note"
          />
        </div>
      )}
      <p id="conversation-naming-note" className="settings-field-note" data-testid="conversation-naming-note">
        {namingNote({ saved, providerId, savedModel, options: [...modeOptions, ...models], loadingCatalog: providerId === 'openrouter' && catalog.state === 'loading' })}
      </p>
    </section>
  );
}

/** What the current choice does. `options` marks a saved provider or model that is no longer offered. */
function namingNote(state: {
  readonly saved: NamingMode;
  readonly providerId: NamingProviderId | null;
  readonly savedModel: string | null;
  readonly options: readonly SelectOption[];
  readonly loadingCatalog: boolean;
}): string {
  if (state.loadingCatalog) return 'Loading models…';
  if (state.providerId === null) {
    return state.saved === null
      ? 'New conversations keep their numbered titles.'
      : 'Uses a small model from each conversation\'s own provider; if it offers none, the conversation keeps its numbered title.';
  }
  if (state.savedModel === null) return 'Choose a model to name with it.';
  if (state.options.some((option) => option.label.endsWith('(unavailable)'))) {
    return 'This model is not available right now, so new conversations keep their default titles. Choose another, Automatic or Off.';
  }
  return 'New conversations are named with this model.';
}
