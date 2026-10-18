import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIProviderId, AIProviderStatus, ReasoningEffort } from '@shared/types/ai';
import { AppIcon } from '../../components/AppIcon';
import { usePopoverPresence } from '../../components/ui/popover-presence';
import type { ProviderDiscoveryState } from '../../stores/use-chat-store';
import { ChatModelPickerPopover, MODEL_PICKER_POPOVER_ID } from './ChatModelPickerPopover';
import { ChatModelTriggerEffort, repeatsBinding, triggerAriaLabel, triggerEffort } from './ChatModelTriggerEffort';
import { displayProviderName } from './chat-labels';
import { pickerGroups, triggerLabel, type OpenRouterPickerSource, type PickerRow } from './model-picker-options';
import { useOpenRouterCatalog } from './use-openrouter-catalog';
import './chat-reasoning.css';

type ChatModelPickerProps = {
  /** Every provider main reported, so a binding that lost readiness can still be named. */
  readonly providers: readonly AIProviderStatus[];
  /** Only these are offered as choices: main's current, actionable providers. */
  readonly readyProviders: readonly AIProviderStatus[];
  readonly discovery: ProviderDiscoveryState;
  readonly currentProviderId: AIProviderId;
  readonly currentModelId: string | null;
  /** The level saved with the binding; `null` is Default. */
  readonly currentReasoningEffort: ReasoningEffort | null;
  readonly currentProviderReady: boolean;
  /** Settings' persisted OpenRouter model, used only to label an Auto binding. */
  readonly openRouterConfiguredModel: string | null;
  readonly disabled: boolean;
  readonly settingsOpen: boolean;
  /** One choice, one call: the provider, the exact model and its level travel together. */
  readonly onSelectModel: (providerId: AIProviderId, modelId: string, reasoningEffort: ReasoningEffort | null) => void;
  readonly onOpenProviderSettings: () => void;
};

/**
 * The composer's one model control: a trigger naming the model and the
 * provider that runs it, over a searchable list grouped by ready provider.
 *
 * Picking a row hands the exact provider-and-model pair to the caller in a
 * single call. Re-choosing the bound row only closes the list. OpenRouter's
 * catalog is listed by main when the list opens; a failed or slow listing
 * never substitutes a model, and ids the catalog no longer lists keep their
 * label as unavailable rows rather than disappearing.
 */
export function ChatModelPicker({
  providers,
  readyProviders,
  discovery,
  currentProviderId,
  currentModelId,
  currentReasoningEffort,
  currentProviderReady,
  openRouterConfiguredModel,
  disabled,
  settingsOpen,
  onSelectModel,
  onOpenProviderSettings,
}: ChatModelPickerProps) {
  const [open, setOpen] = useState(false);
  const presence = usePopoverPresence(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);
  const returnAfterSettingsRef = useRef(false);
  const catalog = useOpenRouterCatalog();
  const fetchCatalog = catalog.fetch;
  const openRouterReady = readyProviders.some((provider) => provider.id === 'openrouter');

  useEffect(() => {
    if (open && openRouterReady) void fetchCatalog();
  }, [open, openRouterReady, fetchCatalog]);

  /**
   * Writing the binding disables this control while it is in flight, and a
   * disabled button cannot hold focus, so the browser drops it on the document
   * body. Bring it back to the trigger once the write settles.
   */
  useEffect(() => {
    if (disabled || !returnFocusRef.current) return;
    returnFocusRef.current = false;
    if (document.activeElement === document.body) triggerRef.current?.focus();
  }, [disabled]);

  useEffect(() => {
    if (settingsOpen || !returnAfterSettingsRef.current) return;
    returnAfterSettingsRef.current = false;
    window.queueMicrotask(() => { triggerRef.current?.focus(); });
  }, [settingsOpen]);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) window.queueMicrotask(() => { triggerRef.current?.focus(); });
  }, []);

  const openRouter: OpenRouterPickerSource = {
    state: catalog.state,
    models: catalog.models,
    configuredModel: openRouterConfiguredModel,
  };
  const currentProviderInfo = providers.find((provider) => provider.id === currentProviderId);
  const label = triggerLabel({ providerId: currentProviderId, providerInfo: currentProviderInfo, modelId: currentModelId, openRouter });
  // A claim about readiness is only made once a probe has actually finished.
  const unavailable = !currentProviderReady && discovery === 'succeeded';
  const groups = pickerGroups(readyProviders, openRouter, { providerId: currentProviderId, modelId: currentModelId });
  const boundRow = groups.flatMap((group) => group.rows).find((row) => row.providerId === currentProviderId && row.modelId === currentModelId);
  const selectedKey = boundRow?.key ?? null;
  const binding = { providerId: currentProviderId, modelId: currentModelId, reasoningEffort: currentReasoningEffort };
  const effort = triggerEffort(providers, binding, catalog.state, boundRow);

  const choose = (row: PickerRow, level: ReasoningEffort | null): void => {
    // Focus moves back synchronously, before anything downstream can disable
    // the trigger or open a dialog that captures a return target.
    triggerRef.current?.focus();
    close(false);
    if (repeatsBinding(row, level, binding)) return;
    returnFocusRef.current = true;
    onSelectModel(row.providerId, row.modelId, level);
  };

  const ariaLabel = triggerAriaLabel(label, effort, unavailable);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id="chat-model-picker"
        data-testid="chat-model-picker"
        data-provider-id={currentProviderId}
        data-model-id={currentModelId ?? ''}
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? MODEL_PICKER_POPOVER_ID : undefined}
        disabled={disabled}
        onClick={() => { setOpen(!open); }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
        className="chat-model-trigger"
      >
        <AppIcon name="ai-model" size={14} className="chat-model-trigger-icon" />
        <span className="chat-model-trigger-model">
          <span className="chat-model-trigger-lead">{label.lead}</span>
          {label.model.slice(label.lead.length)}
        </span>
        {label.provider !== null && <span className="chat-model-trigger-provider">{label.provider}</span>}
        <ChatModelTriggerEffort effort={effort} />
        {unavailable && (
          <span className="chat-model-trigger-badge">
            <AppIcon name="warning" size={12} className="chat-model-trigger-badge-icon" />
            <span className="chat-model-trigger-badge-text">Unavailable</span>
          </span>
        )}
        <AppIcon name="menu-caret" size={12} className="chat-model-trigger-caret" />
      </button>
      {presence.present && (
        <ChatModelPickerPopover
          phase={presence.phase}
          triggerRef={triggerRef}
          groups={groups}
          selectedKey={selectedKey}
          selectedEffort={currentReasoningEffort}
          discovery={discovery}
          unavailableProvider={unavailable ? displayProviderName(currentProviderId, currentProviderInfo?.name) : null}
          catalog={openRouterReady ? { state: catalog.state, error: catalog.error } : null}
          onRetryCatalog={() => { void fetchCatalog(true); }}
          onChoose={choose}
          onManageProviders={() => {
            // Settings returns focus to whatever was focused when it opened, so
            // the trigger has to hold focus before the dialog mounts.
            triggerRef.current?.focus();
            returnAfterSettingsRef.current = true;
            close(false);
            onOpenProviderSettings();
          }}
          onDismiss={close}
        />
      )}
    </>
  );
}
