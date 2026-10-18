import { useEffect } from 'react';
import type { UpdateState } from '@shared/schemas/updates';
import { useUpdateStore, type UpdateNotice } from '../../stores/use-update-store';
import { Button } from '../../components/ui/button';
import type { SettingsSectionProps } from './PreferenceSettingsSections';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { activeWorkText, canCheck, downloadableVersion, lastCheckedText, updateStatusText } from './update-status-copy';

/**
 * About & Updates. Shows the running version and main's update state, and
 * offers only the next sensible step: check, download, restart, or the release
 * page. Downloads start only from the button, restarts never happen on their
 * own, and release notes are read on the release page rather than rendered here.
 */

function noticeText(notice: UpdateNotice): string {
  return notice.kind === 'blocked' ? activeWorkText(notice.activeWork) : notice.message;
}

function UpdateActions({ state }: { readonly state: UpdateState }) {
  const pending = useUpdateStore((store) => store.pending);
  const { check, download, restart, openReleasePage } = useUpdateStore.getState();
  const { phase } = state;
  const version = downloadableVersion(phase);
  const selfUpdating = state.support === 'self-update';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {selfUpdating && (
        <Button data-testid="updates-check" variant="outline" size="sm" disabled={pending !== null || !canCheck(state)} onClick={() => { void check(); }}>
          Check for updates
        </Button>
      )}
      {selfUpdating && version !== null && (
        <Button data-testid="updates-download" variant="primary" size="sm" disabled={pending !== null} onClick={() => { void download(); }}>
          Download {version}
        </Button>
      )}
      {selfUpdating && phase.status === 'downloaded' && (
        <Button data-testid="updates-restart" variant="primary" size="sm" disabled={pending !== null} onClick={() => { void restart(); }}>
          Restart to update
        </Button>
      )}
      <Button data-testid="updates-release-page" variant="outline" size="sm" disabled={pending !== null} onClick={() => { void openReleasePage(); }}>
        Open release page
      </Button>
    </div>
  );
}

export function AboutUpdatesPanel({ settings, onChange }: SettingsSectionProps) {
  const state = useUpdateStore((store) => store.state);
  const notice = useUpdateStore((store) => store.notice);
  useEffect(() => useUpdateStore.getState().connect(), []);
  const lastChecked = state === null ? null : lastCheckedText(state.lastCheckedAt);
  return (
    <section aria-labelledby="settings-about-heading">
      <SettingsSectionHeader
        id="settings-about-heading"
        title="About & Updates"
        description={<span data-testid="updates-version">Interleaf {state?.currentVersion ?? '…'} · Stable channel</span>}
      />
      {state !== null && (
        <div className="max-w-md rounded-md border border-border-subtle bg-bg-surface p-3">
          <p role="status" aria-live="polite" data-testid="updates-status" className="text-xs leading-relaxed text-text-primary">{updateStatusText(state)}</p>
          {state.phase.status === 'downloading' && (
            <progress className="mt-2 w-full" max={100} value={state.phase.percent} aria-label="Update download progress" />
          )}
          {lastChecked !== null && <p className="mt-1 text-2xs text-text-secondary">{lastChecked}</p>}
          <UpdateActions state={state} />
        </div>
      )}
      {notice !== null && <p role="alert" data-testid="updates-notice" className="mt-3 max-w-md rounded-md bg-danger/10 p-2 text-xs text-danger">{noticeText(notice)}</p>}
      <label className="mt-4 flex max-w-md items-start gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          data-testid="settings-updates-automatic-checks"
          checked={settings.updates.automaticChecks}
          onChange={(event) => {
            onChange({ ...settings, updates: { ...settings.updates, automaticChecks: event.target.checked } });
          }}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-text-primary">Check for updates automatically</span>
          <span className="mt-1 block text-2xs leading-relaxed">Shortly after launch and then twice a day, Interleaf asks the public release page whether a newer stable version exists. It sends no document, account or usage data, and it downloads nothing until you choose to.</span>
        </span>
      </label>
    </section>
  );
}
