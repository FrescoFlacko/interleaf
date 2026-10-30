import { useState, type ReactElement } from 'react';
import type { AIModelInfo, AIProviderStatus } from '@shared/types/ai';
import type { AppSettings } from '@shared/schemas/settings';
import {
  DEFAULT_LOCAL_ENDPOINT,
  LOCAL_ENDPOINT_MAX_LENGTH,
  LOOPBACK_ENDPOINT_MESSAGES,
  parseLoopbackEndpoint,
  type LocalEndpointMode,
} from '@shared/schemas/local-endpoint';
import { Select } from '../../components/ui/select';
import type { SelectOption } from '../../components/ui/select-model';

export type LocalProviderPanelProps = {
  readonly settings: AppSettings;
  readonly onSettingsChange: (next: AppSettings) => void;
  /** Live status from main; `undefined` until the first probe resolves. */
  readonly status: AIProviderStatus | undefined;
  readonly settingsReady: boolean;
  readonly checking: boolean;
  /** Re-probes the server. Read-only: it lists models and runs no inference. */
  readonly onCheckConnection: () => void;
};

const MODE_LABELS: Readonly<Record<LocalEndpointMode, string>> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible (llama.cpp, LM Studio)',
};

const MODE_OPTIONS: readonly SelectOption<LocalEndpointMode>[] = (Object.keys(MODE_LABELS) as LocalEndpointMode[])
  .map((mode) => ({ value: mode, label: MODE_LABELS[mode] }));

function localModelOptions(models: readonly AIModelInfo[]): SelectOption[] {
  return [
    { value: '', label: models.length === 0 ? 'No models available' : 'Use the first available model' },
    ...models.map((model) => ({ value: model.id, label: model.name })),
  ];
}

const MODE_NOTES: Readonly<Record<LocalEndpointMode, string>> = {
  ollama: 'Uses Ollama’s OpenAI-compatible API, plus its read-only model metadata to read each model’s real context window.',
  'openai-compatible': 'Uses only /v1/models and /v1/chat/completions. Context window is unknown over this API, so a conservative default is assumed.',
};

/**
 * Configuration for the loopback server provider.
 *
 * The disclosure at the bottom is the point of this panel, not decoration.
 * Everything else here is an endpoint and a dropdown; what a user actually
 * needs to know is that "local" describes the connection Interleaf makes and
 * not where the model runs, and that only the runtime can settle the
 * difference.
 */
export function LocalProviderPanel(props: LocalProviderPanelProps): ReactElement {
  const saved = props.settings.ai.local;
  const [endpointDraft, setEndpointDraft] = useState(saved.endpoint);
  const parsed = parseLoopbackEndpoint(endpointDraft);
  const endpointError = parsed.ok ? null : LOOPBACK_ENDPOINT_MESSAGES[parsed.reason];
  const models = props.status?.models ?? [];
  const dirty = endpointDraft.trim() !== saved.endpoint;
  const savedModelAvailable = saved.model === null || models.some((model) => model.id === saved.model);

  const commit = (next: AppSettings['ai']['local']): void => {
    props.onSettingsChange({
      ...props.settings,
      ai: { ...props.settings.ai, local: next },
    });
  };

  const applyEndpoint = (): void => {
    if (!parsed.ok) return;
    // The canonical origin is stored, not the exact text typed, so what is
    // saved and what is connected to are the same string.
    commit({ ...saved, endpoint: parsed.endpoint.origin, model: null });
    setEndpointDraft(parsed.endpoint.origin);
  };

  return (
    <>
      <p className="provider-lede">{'Chat with a model served from this machine over a loopback connection.'}</p>

      <div className="settings-field">
        <label htmlFor="local-mode-select" className="settings-field-label">Server type</label>
        <Select
          id="local-mode-select"
          data-testid="local-mode-select"
          value={saved.mode}
          disabled={!props.settingsReady}
          options={MODE_OPTIONS}
          // The catalogs differ between modes, so a model chosen under the
          // old one is cleared rather than left pointing at something the
          // new mode may not publish.
          onValueChange={(mode) => { commit({ ...saved, mode, model: null }); }}
        />
        <span className="settings-field-note">{MODE_NOTES[saved.mode]}</span>
      </div>

      <div className="settings-field">
        <label htmlFor="local-endpoint-input" className="settings-field-label">Server address</label>
        <div className="flex min-w-0 items-stretch gap-2.5">
          <input
            id="local-endpoint-input"
            data-testid="local-endpoint-input"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            maxLength={LOCAL_ENDPOINT_MAX_LENGTH}
            value={endpointDraft}
            placeholder={DEFAULT_LOCAL_ENDPOINT}
            disabled={!props.settingsReady}
            onChange={(event) => { setEndpointDraft(event.target.value); }}
            aria-invalid={endpointError !== null}
            aria-describedby={endpointError === null ? 'local-endpoint-note' : 'local-endpoint-error'}
            className="settings-control settings-control--mono"
          />
          <button
            type="button"
            data-testid="local-endpoint-save-button"
            onClick={applyEndpoint}
            disabled={!props.settingsReady || !parsed.ok || !dirty}
            className="settings-outline-button"
          >
            Use address
          </button>
        </div>
        {endpointError === null
          ? (
            <span id="local-endpoint-note" className="settings-field-note">
              Only 127.0.0.1 and [::1] are accepted, over http, with no path. Ollama’s default is {DEFAULT_LOCAL_ENDPOINT}.
            </span>
          )
          : <span id="local-endpoint-error" role="alert" className="settings-field-note text-danger">{endpointError}</span>}
      </div>

      <div className="settings-field">
        <div className="flex flex-wrap items-baseline gap-3">
          <label htmlFor="local-model-select" className="settings-field-label">Model</label>
          <span
            data-testid="local-connection-status"
            role="status"
            aria-live="polite"
            className={`settings-field-note${props.status?.installed === false ? ' text-danger' : ''}`}
          >
            {connectionText(props)}
          </span>
        </div>
        <div className="flex min-w-0 items-stretch gap-2.5">
          <Select
            id="local-model-select"
            data-testid="local-model-select"
            // A saved model the server no longer lists cannot be shown as the
            // selection, because it is not what a chat would actually use. The
            // status message alongside says so rather than leaving the blank
            // row to be read as "no preference".
            value={savedModelAvailable ? saved.model ?? '' : ''}
            disabled={!props.settingsReady || models.length === 0}
            options={localModelOptions(models)}
            onValueChange={(value) => { commit({ ...saved, model: value === '' ? null : value }); }}
            wrapperClassName="flex-1"
          />
          <button
            type="button"
            data-testid="local-test-connection-button"
            onClick={props.onCheckConnection}
            // An unsaved address must not be testable: the check runs in main
            // against the address that is *stored*, so offering it here while a
            // draft is pending would report on one endpoint while the field
            // shows another. "Use address" first, then check.
            disabled={!props.settingsReady || props.checking || !parsed.ok || dirty}
            className="settings-outline-button"
          >
            {props.checking ? 'Checking…' : 'Check connection'}
          </button>
        </div>
        {dirty && parsed.ok && (
          <span className="settings-field-note">Select “Use address” to save this address before checking it.</span>
        )}
        {props.status?.errorMessage != null && (
          <span data-testid="local-status-error" role="alert" className="settings-field-note text-danger">
            {props.status.errorMessage}
          </span>
        )}
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Where your text goes</span>
        <span data-testid="local-routing-disclosure" className="settings-field-note">
          Interleaf connects only to a loopback address on this machine, and never to a remote host.
          It cannot control what the server does next: Ollama can route a cloud-capable model to Ollama’s
          own servers, and your text would leave this machine that way. For guaranteed on-device inference,
          start Ollama with <code>OLLAMA_NO_CLOUD=1</code>.
        </span>
      </div>
    </>
  );
}

/** One line describing the server, never echoing anything it sent verbatim. */
function connectionText(props: LocalProviderPanelProps): string {
  if (!props.settingsReady) return 'Checking…';
  if (props.checking) return 'Checking the server…';
  if (props.status === undefined) return 'Not checked yet.';
  if (!props.status.installed) return 'No server responded at that address.';
  const count = props.status.models.length;
  if (count === 0) return 'Connected, but the server offers no models.';
  return `Connected — ${String(count)} model${count === 1 ? '' : 's'} available.`;
}
