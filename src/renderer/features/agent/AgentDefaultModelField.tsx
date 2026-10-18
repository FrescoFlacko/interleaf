import type { ReactElement } from 'react';
import { Select } from '../../components/ui/select';
import { defaultModelSelectOptions } from './default-model-select-options';

/**
 * The profile's default model.
 *
 * When the installed CLI can list what it accepts, main publishes that list and
 * the default is picked from it rather than retyped. A CLI that publishes no
 * list keeps the free-text field, so a model only its user knows about stays
 * reachable. Either way the value is a single identifier that main revalidates
 * against its own allowlist before it can reach argv.
 */
export function AgentDefaultModelField({ profileId, availableModels, defaultModel, onChange }: {
  readonly profileId: string;
  readonly availableModels: readonly string[];
  readonly defaultModel: string | null;
  readonly onChange: (defaultModel: string | null) => void;
}): ReactElement {
  // A stored default main no longer offers stays selected and stays visible, so
  // reopening Settings never silently swaps a saved choice for another model.
  const options = defaultModelSelectOptions(availableModels, defaultModel);
  return (
    <label className="settings-field">
      <span className="settings-field-label">Default model</span>
      {options.length > 1 ? (
        <Select
          aria-label="Default model"
          data-testid={`profile-${profileId}-model`}
          value={defaultModel ?? ''}
          options={options}
          onValueChange={(value) => { onChange(value === '' ? null : value); }}
        />
      ) : (
        <input
          data-testid={`profile-${profileId}-model`}
          value={defaultModel ?? ''}
          maxLength={128}
          placeholder="Provider default"
          onChange={(event) => { onChange(event.target.value.trim() === '' ? null : event.target.value.trim()); }}
          className="settings-control"
        />
      )}
    </label>
  );
}
