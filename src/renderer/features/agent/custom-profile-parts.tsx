import type { ReactElement, ReactNode } from 'react';
import { AGENT_EXECUTION_MODE_INFO } from '@shared/constants/agent-modes';
import { toSelectableDefaultExecutionMode } from '@shared/constants/agent-mode-selection';
import type { CustomAgentEnvironmentOverride, CustomAgentProfile } from '@shared/types/custom-agent-profile';
import { Badge } from '../../components/ui/badge';
import { Select } from '../../components/ui/select';
import { CUSTOM_ENVIRONMENT_ACTION_OPTIONS } from './profile-select-options';

/*
 * The Custom Profiles panel drawn from the same Settings recipes as the AI
 * Providers rows (`settings-design.css`): field, label, note, control, the
 * outline and accent buttons, and the shared Badge. Nothing here decides what
 * may run; main validates every saved field again.
 */

/** A labelled Settings field: label, control, then an optional note. */
export function SettingsField({ label, note, className, children }: {
  readonly label: string;
  readonly note?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className={`settings-field${className === undefined ? '' : ` ${className}`}`}>
      <span className="settings-field-label">{label}</span>
      {children}
      {note !== undefined && <span className="settings-field-note">{note}</span>}
    </label>
  );
}

/** A titled group of fields, in place of a bordered native fieldset. */
export function SettingsGroup({ title, className, children }: {
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <fieldset className={`settings-env-block min-w-0${className === undefined ? '' : ` ${className}`}`}>
      <legend className="settings-field-label float-left mb-1 w-full">{title}</legend>
      {children}
    </fieldset>
  );
}

/** A checkbox row in the Settings field type. */
export function SettingsCheck({ label, checked, onChange, children }: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className="flex items-start gap-2 text-xs text-text-primary">
      <input type="checkbox" aria-label={label} checked={checked} onChange={(event) => { onChange(event.target.checked); }} className="mt-0.5 accent-[color:var(--accent)]" />
      <span>{children}</span>
    </label>
  );
}

type ExecutionKind = 'normal' | 'expert-shell';

const EXECUTION_KINDS: readonly { readonly value: ExecutionKind; readonly label: string; readonly description: string }[] = [
  {
    value: 'normal',
    label: 'Direct program (recommended)',
    description: 'Runs the program itself with the arguments below. No shell is involved, so pipes, variables and wildcards are passed on as plain text.',
  },
  {
    value: 'expert-shell',
    label: 'Expert Shell (Dangerous, full OS user authority)',
    description: 'A shell interprets your command, with every shell feature available. Each run asks you to confirm first.',
  },
];

/** How the program is started, as two selectable cards. */
export function ExecutionKindCards({ value, onChange }: {
  readonly value: ExecutionKind;
  readonly onChange: (kind: ExecutionKind) => void;
}): ReactElement {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 sm:col-span-2">
      <legend className="settings-field-label mb-1.5">How it runs</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {EXECUTION_KINDS.map((kind) => (
          <label
            key={kind.value}
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-border-subtle bg-bg-surface-elevated p-3 has-[:checked]:border-accent has-[:checked]:bg-accent/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus-ring"
          >
            <input
              type="radio"
              name="executionKind"
              value={kind.value}
              checked={value === kind.value}
              onChange={() => { onChange(kind.value); }}
              className="mt-0.5 accent-[color:var(--accent)]"
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className={`text-xs font-medium ${kind.value === 'expert-shell' ? 'text-danger' : 'text-text-primary'}`}>{kind.label}</span>
              <span className="settings-field-note">{kind.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** One saved profile: name, plain facts, sentence-case badges and actions. */
export function CustomProfileRow({ profile, onEdit, onDelete }: {
  readonly profile: CustomAgentProfile;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  const facts = [
    profile.executable?.displayName ?? 'Program unavailable',
    AGENT_EXECUTION_MODE_INFO[toSelectableDefaultExecutionMode(profile.defaultSandboxMode)].label,
    ...(profile.supportsResume ? ['Resumable'] : []),
    ...(profile.defaultModel ? [profile.defaultModel] : []),
  ];
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-surface-elevated px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="truncate text-xs font-medium text-text-primary">{profile.name}</p>
          {profile.executionKind === 'expert-shell' && <Badge tone="danger" size="pill">Expert shell</Badge>}
          <Badge tone="outline" size="pill">Unverified</Badge>
          {profile.unsafe && <Badge tone="warning" size="pill">Extra warning</Badge>}
        </div>
        <p className="settings-field-note truncate">{facts.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button type="button" aria-label={`Edit ${profile.name}`} onClick={onEdit} className="settings-inline-action">Edit</button>
        <button type="button" aria-label={`Delete ${profile.name}`} onClick={onDelete} className="settings-inline-action settings-inline-action--danger">Delete</button>
      </div>
    </div>
  );
}

/** Variables passed through or cleared by name; their values are never shown. */
export function EnvironmentOverridesField({ overrides, onChange }: {
  readonly overrides: readonly CustomAgentEnvironmentOverride[];
  readonly onChange: (next: readonly CustomAgentEnvironmentOverride[]) => void;
}): ReactElement {
  const update = (index: number, patch: Partial<CustomAgentEnvironmentOverride>): void => {
    onChange(overrides.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };
  return (
    <SettingsGroup title="Environment variables" className="mt-3">
      <p className="settings-field-note">
        Pass a variable through to the program, or clear it, by name. Only common system variables such as PATH or HOME can be passed through. Values are never shown or saved here.
      </p>
      {overrides.map((override, index) => (
        <div key={`${override.name}-${String(index)}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
          <input aria-label={`Environment variable ${String(index + 1)} name`} maxLength={64} value={override.name} placeholder="NAME" onChange={(event) => { update(index, { name: event.target.value }); }} className="settings-control settings-control--mono" />
          <Select aria-label={`Environment variable ${String(index + 1)} action`} value={override.action} options={CUSTOM_ENVIRONMENT_ACTION_OPTIONS} onValueChange={(action) => { update(index, { action }); }} size="sm" />
          <button type="button" aria-label={`Remove environment variable ${String(index + 1)}`} onClick={() => { onChange(overrides.filter((_, itemIndex) => itemIndex !== index)); }} className="settings-inline-action settings-inline-action--danger">Remove</button>
        </div>
      ))}
      <button type="button" disabled={overrides.length >= 32} onClick={() => { onChange([...overrides, { name: '', action: 'inherit-allowlisted' }]); }} className="settings-inline-action self-start">Add variable</button>
    </SettingsGroup>
  );
}
