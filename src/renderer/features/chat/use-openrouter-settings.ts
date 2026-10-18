import { useCallback, useRef, useState } from 'react';
import type { AppSettings } from '@shared/schemas/settings';
import {
  parseOpenRouterKeyPreview,
  type CredentialStorageStatus,
  type OpenRouterCredentialStatus,
  type OpenRouterKeyPreview,
} from '@shared/schemas/credential-preview';
import { bridge } from '../../app/api-client';
import { useOpenRouterKeyRemoval } from './openrouter-credential-removal';
import { buildModelOptions } from './openrouter-model-options';
import { planOpenRouterCommit } from './openrouter-draft-validation';
import type { OpenRouterPanelProps } from './OpenRouterPanel';
import { useOpenRouterCatalog, type OpenRouterCatalog } from './use-openrouter-catalog';
import { useOpenRouterConnectionTest } from './use-openrouter-connection-test';
import type { ProviderStatuses } from './use-provider-statuses';
import type { SettingsFeedback } from './use-settings-feedback';

/** Done's verdict: `blocked` keeps the dialog open; `done` lets it close. */
/** `invalid`: a draft failed validation, so the dialog must reveal the row. */
type OpenRouterCommitOutcome = 'blocked' | 'done' | 'invalid';

export type OpenRouterSettings = {
  readonly configured: boolean;
  readonly keyPreview: OpenRouterKeyPreview | null;
  /** A save or a removal is in flight, so Done must not start another write. */
  readonly busy: boolean;
  readonly saving: boolean;
  readonly catalog: OpenRouterCatalog;
  /** Adopts the masked credential status and the saved model from a load. */
  readonly adoptLoaded: (status: OpenRouterCredentialStatus, savedModel: string) => void;
  readonly clearFieldErrors: () => void;
  /** Forgets this panel's drafts and session state for a newly opened dialog. */
  readonly resetForOpen: () => void;
  /** Reveals and focuses the key field. */
  readonly requestKeyFocus: () => void;
  /** Validates and saves the drafts for Done. */
  readonly commit: (aiSectionActive: boolean) => Promise<OpenRouterCommitOutcome>;
  readonly panelProps: (denseZoomLayout: boolean) => OpenRouterPanelProps;
};

/**
 * Owns the OpenRouter row: the masked credential, the key and model drafts,
 * their validation and save, removal, model discovery and the connection test.
 *
 * The raw key exists in renderer state only while the reader is typing it; the
 * stored credential is represented solely by main's masked preview.
 */
export function useOpenRouterSettings({ feedback, providers, onProvidersChanged, onSaved }: {
  readonly feedback: SettingsFeedback;
  readonly providers: Pick<ProviderStatuses, 'adoptStatus'>;
  readonly onProvidersChanged: () => void;
  /** Hands the settings document main returned to the shared coordinator. */
  readonly onSaved: (confirmed: AppSettings) => void;
}): OpenRouterSettings {
  const [configured, setConfigured] = useState(false);
  const [keyPreview, setKeyPreview] = useState<OpenRouterKeyPreview | null>(null);
  /** Main's non-secret credential-store report; `null` until a status carries one. */
  const [storage, setStorage] = useState<CredentialStorageStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [savedModel, setSavedModel] = useState('openrouter/auto');
  const [modelDraft, setModelDraft] = useState('openrouter/auto');
  const [modelError, setModelError] = useState<string | null>(null);
  // Incremented to focus the key field (Add provider, or removal).
  const [focusKeyRequest, setFocusKeyRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const catalog = useOpenRouterCatalog();
  const connectionTest = useOpenRouterConnectionTest(feedback);
  const resetTestResult = connectionTest.reset;

  // Removal is immediate and main-owned: the record is deleted as soon as
  // Remove is clicked, and this panel adopts the masked status that replaced it
  // without waiting for Done. A failure leaves the shown state as it was.
  const { removingKey, credentialRemoved, removeKey, resetRemoval } = useOpenRouterKeyRemoval({
    onStart: feedback.clear,
    onRemoved: (removal) => {
      setConfigured(removal.configured);
      setKeyPreview(removal.keyPreview);
      setKeyError(null);
      connectionTest.reset();
      // Remove takes the focused button out of the tree with it, so focus is
      // moved deliberately to the field that is now the whole recovery path
      // instead of being dropped on the document. A replacement the reader had
      // already started typing is left in the field, not silently discarded.
      setFocusKeyRequest((count) => count + 1);
      // Reader Chat and every other provider consumer must stop offering a
      // credential that no longer exists. A status that could not be re-read
      // is not published; the next status load corrects the row.
      if (removal.providerStatus !== null) providers.adoptStatus(removal.providerStatus);
      onProvidersChanged();
      feedback.announce('OpenRouter API key removed from this device.');
    },
    onFailed: feedback.fail,
  });

  const adoptLoaded = useCallback((status: OpenRouterCredentialStatus, model: string): void => {
    setConfigured(status.configured);
    // Masked projection only, re-validated at this boundary: a malformed or
    // undecryptable preview degrades to the fully masked chip.
    setKeyPreview(parseOpenRouterKeyPreview(status.keyPreview));
    // Re-validated at this boundary like the preview: an unexpected value is
    // "not reported" rather than a state the panel would act on.
    setStorage(status.storageBackend);
    setSavedModel(model);
    setModelDraft(model);
  }, []);

  const clearFieldErrors = useCallback((): void => {
    setKeyError(null);
    setModelError(null);
  }, []);

  const resetForOpen = useCallback((): void => {
    setFocusKeyRequest(0);
    setKeyDraft('');
    resetRemoval();
    resetTestResult();
  }, [resetRemoval, resetTestResult]);

  const save = async (key: string, model: string): Promise<OpenRouterCommitOutcome> => {
    savingRef.current = true;
    setSaving(true);
    try {
      const nextSettings = await bridge.ai.configureOpenRouter({
        ...(key.length > 0 ? { apiKey: key } : {}),
        model,
      });
      onSaved(nextSettings);
      setSavedModel(model);
      // A typed key is now stored; otherwise whatever was there is unchanged.
      setConfigured(configured || key.length > 0);
      resetRemoval();
      onProvidersChanged();
      return 'done';
    } catch (err) {
      feedback.fail(err instanceof Error ? err.message : 'Failed to save OpenRouter settings.');
      return 'blocked';
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reportInvalid = (plan: Extract<ReturnType<typeof planOpenRouterCommit>, { kind: 'invalid' }>): 'invalid' => {
    setKeyError(plan.keyError);
    setModelError(plan.modelError);
    // The row may be collapsed, so the reason is also summarised where Done is.
    feedback.fail(`OpenRouter: ${plan.keyError ?? plan.modelError ?? 'check the settings.'}`);
    if (plan.keyError !== null) setFocusKeyRequest((count) => count + 1);
    return 'invalid';
  };

  const commit = async (aiSectionActive: boolean): Promise<OpenRouterCommitOutcome> => {
    // A deletion in flight is a credential write of its own: Done must not
    // start a second one against the same store, or commit a decision made
    // against a state the removal is about to replace.
    if (savingRef.current || saving || removingKey) return 'blocked';
    feedback.clear();
    clearFieldErrors();
    const drafts = { key: keyDraft.trim(), model: modelDraft.trim(), savedModel };
    const plan = planOpenRouterCommit({ drafts, aiSectionActive, credentialRemoved, storage, configured, catalog });
    if (plan.kind === 'nothing') return 'done';
    if (plan.kind === 'invalid') return reportInvalid(plan);
    return save(drafts.key, drafts.model);
  };

  const panelProps = (denseZoomLayout: boolean): OpenRouterPanelProps => ({
    configured,
    keyPreview,
    focusKeyRequest,
    keyDraft,
    onKeyDraftChange: (value) => {
      setKeyDraft(value);
      setKeyError(null);
      feedback.clearError();
    },
    keyError,
    storage,
    onRemoveKey: removeKey,
    removingKey,
    savingSettings: saving,
    models: buildModelOptions({ catalogModels: catalog.models, configuredModel: savedModel, draftModel: modelDraft }),
    modelDraft,
    onModelDraftChange: (value) => {
      setModelDraft(value);
      setModelError(null);
      feedback.clearError();
    },
    modelError,
    catalogState: catalog.state,
    catalogError: catalog.error,
    onRetryCatalog: () => { void catalog.fetch(true); },
    testing: connectionTest.testing,
    onTestConnection: () => { void connectionTest.test(); },
    testResult: connectionTest.result,
    denseZoomLayout,
  });

  return {
    configured,
    keyPreview,
    busy: saving || removingKey,
    saving,
    catalog,
    adoptLoaded,
    clearFieldErrors,
    resetForOpen,
    requestKeyFocus: () => { setFocusKeyRequest((count) => count + 1); },
    commit,
    panelProps,
  };
}
