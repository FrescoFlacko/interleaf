import { useEffect, useRef, type ReactElement } from 'react';
import {
  formatOpenRouterKeyPreview,
  type CredentialStorageStatus,
  type OpenRouterKeyPreview,
} from '@shared/schemas/credential-preview';
import { modelMetadataItems, modelSelectLabel, type ModelOption } from './openrouter-model-options';
import { openRouterCredentialState } from './provider-rows';
import {
  CredentialStorageNotice,
  credentialStorageBlocked,
  keyDescribedBy,
} from './credential-storage-ux';
import { AppIcon } from '../../components/AppIcon';
import { Select } from '../../components/ui/select';

export type OpenRouterPanelProps = {
  readonly configured: boolean;
  /** Masked projection only. The raw key never reaches the renderer; a
   * replacement exists here solely while the user is typing it. */
  readonly keyPreview: OpenRouterKeyPreview | null;
  /** Incremented by the dialog to reveal and focus the key field. */
  readonly focusKeyRequest: number;
  readonly keyDraft: string;
  readonly onKeyDraftChange: (value: string) => void;
  readonly keyError: string | null;
  /** Main's non-secret report on the OS credential store, or `null` when the
   * status did not carry one. An unavailable store means no key can be saved. */
  readonly storage: CredentialStorageStatus | null;
  /** Deletes the stored credential at once; nothing is staged until Done. */
  readonly onRemoveKey: () => void;
  readonly removingKey: boolean;
  /** A save is in flight, so this panel must not start a competing write. */
  readonly savingSettings: boolean;
  readonly models: readonly ModelOption[];
  readonly modelDraft: string;
  readonly onModelDraftChange: (value: string) => void;
  readonly modelError: string | null;
  readonly catalogState: 'idle' | 'loading' | 'ready' | 'error';
  readonly catalogError: string | null;
  readonly onRetryCatalog: () => void;
  readonly testing: boolean;
  readonly onTestConnection: () => void;
  readonly testResult: { readonly success: boolean; readonly message: string } | null;
  readonly denseZoomLayout: boolean;
};

/**
 * What the one password field says in each credential state. The field itself
 * is identical everywhere; only the wording around it changes, so the states
 * stay a lookup rather than a chain of conditions in the markup.
 */
const KEY_FIELD_COPY = {
  absent: { placeholder: 'sk-or-v1-...', note: null },
  ready: { placeholder: 'Enter a replacement key', note: 'Leave blank to keep the existing key.' },
  'stored-unreadable': {
    placeholder: 'Enter a replacement key',
    note: 'Enter a new key to replace the unreadable one. Leaving this blank keeps the stored key as it is.',
  },
} as const;

/** OpenRouter's expanded accordion content (design 5a). */
export function OpenRouterPanel(props: OpenRouterPanelProps): ReactElement {
  const keyInputRef = useRef<HTMLInputElement>(null);
  const { focusKeyRequest } = props;
  useEffect(() => {
    if (focusKeyRequest > 0) keyInputRef.current?.focus();
  }, [focusKeyRequest]);
  // A stored key whose preview main could not derive is unusable, so it is
  // never presented as Saved/Ready and cannot be tested; typing a new key into
  // the field below, or removing the stored one, stays the recovery path.
  const credential = openRouterCredentialState(props);
  const unreadable = credential === 'stored-unreadable';
  const copy = KEY_FIELD_COPY[credential];
  // Main refuses the write when the OS has no usable secret store, so the
  // field is closed here and the remedy is stated instead of letting the user
  // type a key into a save that cannot succeed. Removal stays available.
  const storageBlocked = credentialStorageBlocked(props.storage);
  const selected = props.models.find((model) => model.id === props.modelDraft);
  return (
    <>
      <p className="provider-lede">Provides models via your OpenRouter account using local OS-encrypted key storage.</p>

      <div className="settings-field">
        <span className="settings-field-label" id="openrouter-key-label">API key</span>
        {props.configured && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="settings-key-chip">
              <span className="settings-key-value" data-testid="openrouter-key-preview">
                {props.keyPreview === null ? 'sk-or-v1 ···· ···· ····' : formatOpenRouterKeyPreview(props.keyPreview)}
              </span>
              <span className={`settings-key-saved ${unreadable ? 'text-warning' : ''}`} data-testid="openrouter-key-state">
                {unreadable ? 'Unreadable' : 'Saved'}
              </span>
            </span>
            <button
              type="button"
              data-testid="remove-openrouter-key-button"
              onClick={props.onRemoveKey}
              // Main serializes the two writes anyway; this only keeps the
              // reader from starting a deletion that races a save they can
              // still see running.
              disabled={props.removingKey || props.savingSettings}
              aria-busy={props.removingKey}
              className="settings-inline-action settings-inline-action--danger"
            >
              {props.removingKey ? 'Removing…' : 'Remove'}
            </button>
          </div>
        )}
        {unreadable && (
          <span role="status" data-testid="openrouter-key-unreadable" className="settings-field-note text-warning">
            This saved key could not be read from encrypted storage, so it cannot be used. Type a new key in the field below to restore access, or remove it.
          </span>
        )}
        <CredentialStorageNotice storage={props.storage} />
        {/* One password field for every state. It holds only what the reader
            is typing now: a first key, or a replacement for a saved or
            unreadable one. The stored key is not readable here — plaintext
            never reaches the renderer — so the saved value is shown as the
            masked chip above and never as this input's value. */}
        <input
          id="openrouter-key-input"
          data-testid="openrouter-key-input"
          ref={keyInputRef}
          type="password"
          value={props.keyDraft}
          onChange={(event) => { props.onKeyDraftChange(event.target.value); }}
          placeholder={copy.placeholder}
          autoComplete="off"
          aria-labelledby="openrouter-key-label"
          aria-invalid={props.keyError !== null}
          // The note explains what a blank field means for the state the panel
          // is in, so it is announced with the field — together with the error
          // when both are present, rather than either replacing the other.
          aria-describedby={keyDescribedBy({ storageBlocked, hasNote: copy.note !== null, hasError: props.keyError !== null })}
          disabled={storageBlocked}
          className="settings-control settings-control--mono"
        />
        {copy.note !== null && <span id="openrouter-key-note" className="settings-field-note">{copy.note}</span>}
        {props.keyError !== null && <span id="openrouter-key-error" role="alert" className="settings-field-note text-danger">{props.keyError}</span>}
      </div>

      <div className="settings-field">
        <div className="flex flex-wrap items-baseline gap-3">
          <label htmlFor="openrouter-model-select" className="settings-field-label">Model</label>
          {props.catalogState === 'loading' && <span role="status" aria-live="polite" className="settings-field-note">Loading model catalog…</span>}
          {props.catalogState === 'error' && (
            <>
              <span role="status" aria-live="polite" className="settings-field-note text-danger">{props.catalogError ?? 'Failed to load models.'}</span>
              <button type="button" data-testid="retry-openrouter-models-button" onClick={props.onRetryCatalog} className="settings-inline-action">Retry</button>
            </>
          )}
        </div>
        <div className="flex min-w-0 items-stretch gap-2.5">
          <Select
            id="openrouter-model-select"
            data-testid="openrouter-model-select"
            value={props.modelDraft}
            options={props.models.map((model) => ({ value: model.id, label: modelSelectLabel(model), disabled: model.legacy }))}
            onValueChange={props.onModelDraftChange}
            aria-invalid={props.modelError !== null}
            aria-describedby={props.modelError === null ? undefined : 'openrouter-model-error'}
            wrapperClassName="flex-1"
          />
          <button
            type="button"
            data-testid="test-openrouter-button"
            onClick={props.onTestConnection}
            disabled={props.testing || credential !== 'ready'}
            className="settings-outline-button"
          >
            {props.testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {selected && (
          <p data-testid="openrouter-model-details" className={`settings-metadata ${props.denseZoomLayout ? 'text-2xs' : ''}`}>
            {selected.legacy
              ? 'This persisted model is no longer in the current catalog. Choose a catalog model before changing it.'
              : modelMetadataItems(selected).map((item) => <span key={item}>{item}</span>)}
          </p>
        )}
        {props.modelError !== null && <span id="openrouter-model-error" role="alert" className="settings-field-note text-danger">{props.modelError}</span>}
      </div>

      {props.testResult && (
        <p data-testid="openrouter-test-result" className={`settings-field-note ${props.testResult.success ? 'text-success' : 'text-danger'}`}>
          {props.testResult.message}
        </p>
      )}
    </>
  );
}

/** Header action that adds the one provider this build can add. */
export function AddProviderButton({ onClick }: { readonly onClick: () => void }): ReactElement {
  return (
    <button type="button" data-testid="add-provider-button" onClick={onClick} className="settings-accent-button">
      <AppIcon name="add" size={13} />
      Add provider
    </button>
  );
}
