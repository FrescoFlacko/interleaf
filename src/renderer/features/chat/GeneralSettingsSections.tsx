import type { AppSettings } from '@shared/schemas/settings';
import { ACTIVE_SHORTCUTS } from '@shared/constants/shortcuts';
import { useUiStore } from '../../stores/use-ui-store';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import { Select } from '../../components/ui/select';
import type { SelectOption } from '../../components/ui/select-model';
import { PrivacyPolicy } from './PrivacyPolicy';
import type { SettingsSectionProps } from './PreferenceSettingsSections';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/** Reader-facing names for the sort orders the library already supports. */
const DEFAULT_VIEW_OPTIONS: readonly SelectOption<AppSettings['library']['defaultView']>[] = [
  { value: 'grid', label: 'Grid' },
  { value: 'list', label: 'List' },
];

const DOCUMENT_SORT_OPTIONS: readonly SelectOption<AppSettings['library']['defaultSort']>[] = [
  { value: 'recent_added', label: 'Recently added' },
  { value: 'recent_read', label: 'Recently read' },
  { value: 'title_asc', label: 'Title (A–Z)' },
  { value: 'title_desc', label: 'Title (Z–A)' },
  { value: 'author_asc', label: 'Author (A–Z)' },
];

export function GeneralSettingsSection({ settings, onChange }: SettingsSectionProps) {
  return (
    <section aria-labelledby="settings-general-heading">
      <SettingsSectionHeader id="settings-general-heading" title="General" description={<>Interleaf keeps your library, reading position, and preferences on this device. Keyboard shortcuts are always available from the help button or <kbd className="rounded border border-border-subtle px-1">?</kbd>.</>} />
      <p className="text-xs leading-relaxed text-text-secondary">Application diagnostics are retained locally in bounded, redacted logs. Export includes only sanitized application records; document bodies, prompts, context packets, credentials, and raw agent output are excluded.</p>
      {/* A launch preference only: the drawer's live open state is untouched,
          and toggling the drawer never changes this. */}
      <label className="mt-4 flex max-w-md items-start gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          data-testid="settings-general-open-right-panel-on-startup"
          checked={settings.layout.openRightPanelOnStartup}
          onChange={(event) => {
            onChange({ ...settings, layout: { ...settings.layout, openRightPanelOnStartup: event.target.checked } });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-text-primary">Open AI drawer on startup</span>
          <span className="mt-1 block text-2xs leading-relaxed">Shows the AI drawer beside the library when Interleaf launches. Applies the next time Interleaf opens.</span>
        </span>
      </label>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-primary">Guided setup</p>
          {/* Resets the walkthrough's own progress only: credentials, provider
              defaults, library and annotations are untouched (§5.3). */}
          <p className="mt-1 text-2xs leading-relaxed text-text-secondary">Walk through provider discovery and defaults again. This does not clear your API keys, chosen defaults, library or annotations.</p>
        </div>
        <button
          type="button"
          data-testid="settings-rerun-onboarding"
          data-onboarding-opener="settings-general-rerun"
          onClick={() => {
            useUiStore.getState().setSettingsOpen(false);
            useOnboardingStore.getState().rerunFromSettings('settings-general-rerun');
          }}
          className="shrink-0 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-text-primary hover:bg-bg-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          Run guided setup
        </button>
      </div>
      <ul className="mt-4 space-y-2">
        {ACTIVE_SHORTCUTS.map((shortcut) => (
          <li key={shortcut.keys} className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5 text-xs">
            <span className="text-text-primary">{shortcut.action}</span>
            <kbd className="shrink-0 rounded border border-border-subtle bg-bg-primary px-1.5 py-0.5 font-mono text-2xs text-text-secondary">{shortcut.keys}</kbd>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LibrarySettingsSection({ settings, onChange }: SettingsSectionProps) {
  return (
    <section aria-labelledby="settings-library-heading">
      <SettingsSectionHeader id="settings-library-heading" title="Library" description="How the library opens. Managed copies are stored in Interleaf’s application data directory; link-in-place documents remain where you chose them and report missing or changed files." />
      <div className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-secondary">Default view
          <Select
            aria-label="Default view"
            data-testid="settings-library-default-view"
            value={settings.library.defaultView}
            options={DEFAULT_VIEW_OPTIONS}
            onValueChange={(defaultView) => { onChange({ ...settings, library: { ...settings.library, defaultView } }); }}
            wrapperClassName="mt-2"
          />
        </label>
        <label className="text-xs text-text-secondary">Default sort
          <Select
            aria-label="Default sort"
            data-testid="settings-library-default-sort"
            value={settings.library.defaultSort}
            options={DOCUMENT_SORT_OPTIONS}
            onValueChange={(defaultSort) => { onChange({ ...settings, library: { ...settings.library, defaultSort } }); }}
            wrapperClassName="mt-2"
          />
        </label>
      </div>
      <p className="mt-3 max-w-md text-2xs leading-relaxed text-text-secondary">Applied when the library opens. Switching view or sort while browsing stays in effect for that session.</p>
    </section>
  );
}

export function PrivacySettingsSection({ settings, onChange }: SettingsSectionProps) {
  return (
    <section aria-labelledby="settings-privacy-heading">
      <SettingsSectionHeader id="settings-privacy-heading" title="Privacy" description="Documents and credentials stay local. API keys use OS-backed secure storage and are never written to the renderer, logs, prompts, or SQLite settings." />
      <label className="flex max-w-md items-start gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          data-testid="settings-privacy-confirm-external-links"
          checked={settings.privacy.confirmExternalLinks}
          onChange={(event) => {
            onChange({ ...settings, privacy: { ...settings.privacy, confirmExternalLinks: event.target.checked } });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-text-primary">Confirm before opening external links</span>
          <span className="mt-1 block text-2xs leading-relaxed">A link in a document opens your browser. With this on, Interleaf shows the exact address first and opens nothing until you accept.</span>
        </span>
      </label>
      <PrivacyPolicy />
    </section>
  );
}

export function AdvancedSettingsSection({ settings, onChange }: SettingsSectionProps) {
  return (
    <section aria-labelledby="settings-advanced-heading">
      <SettingsSectionHeader id="settings-advanced-heading" title="Advanced" description="Security boundaries, provider validation, content sanitization, and database migrations are enforced by the application and are not mutable from here." />
      <label className="flex max-w-md items-start gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          data-testid="settings-advanced-debug-logging"
          checked={settings.advanced.debugLogging}
          onChange={(event) => {
            onChange({ ...settings, advanced: { ...settings.advanced, debugLogging: event.target.checked } });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-text-primary">Record diagnostic debug logging</span>
          <span className="mt-1 block text-2xs leading-relaxed">Adds detailed records to the existing bounded, redacted local log, which you can export from General. Document bodies, prompts, context packets, credentials, and raw agent output stay excluded. Takes effect immediately; no restart is needed.</span>
        </span>
      </label>
    </section>
  );
}
