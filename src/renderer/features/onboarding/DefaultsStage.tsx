import { useMemo, type ReactElement } from 'react';
import { Card, CardLabel } from '../../components/ui/card';
import { Select } from '../../components/ui/select';
import { Separator } from '../../components/ui/separator';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import { useUiStore } from '../../stores/use-ui-store';
import type { OnboardingProviderRow } from './onboarding-rows';
import {
  agentDefaultOptions,
  chatDefaultOptions,
  persistedAgentChoice,
  persistedChatChoice,
  resolveDefaultChoice,
  type DefaultChoice,
  type DefaultOption,
} from './onboarding-defaults';

/**
 * Step 3 — defaults on their own.
 *
 * Detection stays on Step 2: this step asks one question per mode and commits
 * both answers with the footer's single *Continue*. Every control here edits a
 * draft; nothing is written, no credential is read, and no process is started
 * until that one action.
 */

const MODEL_ANY = '';

function SectionFields({
  idPrefix,
  sectionName,
  options,
  selection,
  onChange,
}: {
  readonly idPrefix: string;
  readonly sectionName: string;
  readonly options: readonly DefaultOption[];
  readonly selection: DefaultChoice;
  readonly onChange: (choice: DefaultChoice) => void;
}): ReactElement {
  const selected = options.find((option) => option.id === selection?.id);
  const models = selected?.models ?? [];
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-provider`}>
          <CardLabel>
            Provider<span className="sr-only"> for {sectionName}</span>
          </CardLabel>
        </label>
        <Select
          id={`${idPrefix}-provider`}
          data-testid={`${idPrefix}-provider`}
          value={selected?.id ?? ''}
          options={options.map((option) => ({ value: option.id, label: option.name }))}
          onValueChange={(id) => { onChange({ id, modelId: null }); }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-model`}>
          <CardLabel>
            Model<span className="sr-only"> for {sectionName}</span>
          </CardLabel>
        </label>
        <Select
          id={`${idPrefix}-model`}
          data-testid={`${idPrefix}-model`}
          value={selection?.modelId ?? MODEL_ANY}
          // A runtime that reported no catalog has exactly one honest answer,
          // so the control states it rather than inviting a choice that does
          // not exist.
          disabled={models.length === 0}
          options={[{ value: MODEL_ANY, label: 'Let the provider choose' }, ...models.map((model) => ({ value: model, label: model }))]}
          onValueChange={(value) => { onChange({ id: selected?.id ?? '', modelId: value === MODEL_ANY ? null : value }); }}
        />
      </div>
    </div>
  );
}

function DefaultSection({
  idPrefix,
  title,
  description,
  emptyMessage,
  options,
  selection,
  onChange,
}: {
  readonly idPrefix: string;
  readonly title: string;
  readonly description: string;
  readonly emptyMessage: string;
  readonly options: readonly DefaultOption[];
  readonly selection: DefaultChoice;
  readonly onChange: (choice: DefaultChoice) => void;
}): ReactElement {
  return (
    <section className="flex flex-col gap-3 px-4 py-4" data-testid={idPrefix} aria-label={title}>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-xs leading-[1.45] text-text-secondary">{description}</p>
      </div>
      {options.length === 0 ? (
        <p className="text-xs leading-[1.5] text-text-secondary" data-testid={`${idPrefix}-empty`}>
          {emptyMessage}
        </p>
      ) : (
        <SectionFields
          idPrefix={idPrefix}
          sectionName={title}
          options={options}
          selection={selection}
          onChange={onChange}
        />
      )}
    </section>
  );
}

export function DefaultsStage({ rows }: { readonly rows: readonly OnboardingProviderRow[] }): ReactElement {
  const settings = useUiStore((state) => state.loadedSettings);
  const draft = useOnboardingStore((state) => state.defaultsDraft);
  const setDefaultsDraft = useOnboardingStore((state) => state.setDefaultsDraft);

  const chatOptions = useMemo(() => chatDefaultOptions(rows), [rows]);
  const agentOptions = useMemo(() => agentDefaultOptions(rows), [rows]);

  // The same resolution `commitDefaults` uses, so what the user reads is what
  // Continue would write: their own edit, then a still-available stored
  // default, then the first ready option as a suggestion.
  const chat = resolveDefaultChoice(chatOptions, persistedChatChoice(settings), draft.chat);
  const agent = resolveDefaultChoice(agentOptions, persistedAgentChoice(settings), draft.agent);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-[1.6] text-pretty text-text-secondary">
        Pick what each mode reaches for first. You can change either one later, or in any single session.
      </p>

      <Card className="overflow-hidden bg-bg-surface" data-testid="onboarding-defaults-card">
        <DefaultSection
          idPrefix="onboarding-default-chat"
          title="Reader Chat"
          description="Answers questions about the document you are reading."
          emptyMessage="Nothing is ready for Reader Chat yet. You can add a provider later in Settings — reading and annotations do not need one."
          options={chatOptions}
          selection={chat}
          onChange={(choice) => { setDefaultsDraft({ chat: choice }); }}
        />
        <Separator />
        <DefaultSection
          idPrefix="onboarding-default-agent"
          title="Agent Mode"
          description="Runs multi-step tasks in your workspace."
          emptyMessage="No agent runtime is ready yet. You can choose one later in Settings."
          options={agentOptions}
          selection={agent}
          onChange={(choice) => { setDefaultsDraft({ agent: choice }); }}
        />
      </Card>

      <p className="text-xs leading-[1.6] text-pretty text-text-secondary">
        Choosing a default grants nothing and starts nothing. An agent run still asks for its own
        permission when you start one.
      </p>
    </div>
  );
}
