import type { ReactElement } from 'react';
import type { AgentProfilePreference } from './profile-preferences';
import { Select } from '../../components/ui/select';
import { ENVIRONMENT_ACTION_OPTIONS } from './profile-select-options';

/** The only host variables a profile may pass through or clear. Their values
 * are read and applied by main; the renderer only names them. */
const ALLOWED_ENVIRONMENT_NAMES = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'USER'] as const;

type Overrides = NonNullable<AgentProfilePreference>['environmentOverrides'];

/** Environment override grid from design 5d, merged into the provider row. */
export function AgentProfileEnvironment({
  profileId,
  overrides,
  onChange,
}: {
  readonly profileId: string;
  readonly overrides: Overrides;
  readonly onChange: (next: Overrides) => void;
}): ReactElement {
  return (
    <fieldset className="settings-env-block">
      <legend className="settings-field-label">Environment variables</legend>
      <p className="settings-field-note">Pass these system variables through to the agent, or clear them. Their values are never shown or saved here.</p>
      <div className="settings-env-grid">
        {ALLOWED_ENVIRONMENT_NAMES.map((name) => {
          const override = overrides.find((entry) => entry.name === name);
          return (
            <div key={name} className="flex min-w-0 items-center gap-1.5">
              <label className="flex min-w-0 items-center gap-1.5 settings-env-name">
                <input
                  type="checkbox"
                  data-testid={`profile-${profileId}-env-${name}`}
                  checked={override !== undefined}
                  onChange={(event) => {
                    onChange(event.target.checked
                      ? [...overrides.filter((entry) => entry.name !== name), { name, action: 'inherit-allowlisted' as const }]
                      : overrides.filter((entry) => entry.name !== name));
                  }}
                />
                <span className="truncate">{name}</span>
              </label>
              {override && (
                <Select
                  aria-label={`${name} environment action`}
                  data-testid={`profile-${profileId}-env-${name}-action`}
                  size="sm"
                  value={override.action}
                  options={ENVIRONMENT_ACTION_OPTIONS}
                  onValueChange={(action) => {
                    onChange(overrides.map((entry) => entry.name === name ? { ...entry, action } : entry));
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
