import { useCallback, useRef, useState } from 'react';
import { reportRejection } from '@shared/models/caught-error';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/schemas/settings';
import { enqueueSettingsWrite } from '../../app/api-client';
import { useUiStore } from '../../stores/use-ui-store';
import {
  hydrateStoresFromLoad,
  localProviderSettingsChanged,
  restoreStoresTo,
  showOptimisticSettings,
  syncStoresAfterConfirmedWrite,
  withLiveLayout,
} from './settings-store-sync';
import type { SettingsFeedback } from './use-settings-feedback';

export type SettingsDocument = {
  /** The document every section edits, optimistic while a write is pending. */
  readonly settings: AppSettings;
  /** Adopts a freshly read document and hydrates the stores from it. */
  readonly adoptLoaded: (read: AppSettings) => void;
  /** Adopts a document main confirmed through another write path. */
  readonly adoptConfirmed: (confirmed: AppSettings) => void;
  /**
   * Shows a section edit at once and queues its complete-document write. Only
   * called once the dialog has loaded the document the edit derives from.
   */
  readonly change: (edited: AppSettings) => void;
  /**
   * Settles once the newest queued write, and any local re-probe it started,
   * has finished. Never rejects.
   */
  readonly whenSaved: () => Promise<void>;
};

/**
 * The one place settings-document writes are coordinated.
 *
 * Every section edits the same complete `AppSettings` document, so the order
 * of its writes matters more than any one section. This coordinator protects
 * four orderings:
 *
 * 1. Writes join the app-wide queue shared with every other settings writer,
 *    and each is composed at execution time, so a panel resize persisted while
 *    a write is queued is neither overtaken nor overwritten.
 * 2. Writes are numbered; only the newest one announces success or rolls the
 *    shown document back, so a slow earlier answer cannot replace a newer edit.
 * 3. Each confirmed write is compared with the document the previous write
 *    confirmed, so it reports — and applies to the stores — only its own delta.
 * 4. A write that changes the local provider re-probes it, and `whenSaved`
 *    keeps a connection check behind both, so the check describes the saved
 *    endpoint rather than the one being replaced.
 */
export function useSettingsDocument({ feedback, onLocalProviderChanged }: {
  readonly feedback: SettingsFeedback;
  /** Re-probes the local provider; called when a write changed its settings. */
  readonly onLocalProviderChanged: () => Promise<void>;
}): SettingsDocument {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const confirmedRef = useRef<AppSettings>(DEFAULT_APP_SETTINGS);
  const writeSequenceRef = useRef(0);
  /**
   * The write still in flight, if any, followed by the local re-probe it
   * started. It never rejects: a failed write is reported by its own handler,
   * and a check that followed it should still run against whatever ended up
   * saved.
   */
  const pendingRef = useRef<Promise<void>>(Promise.resolve());

  const adoptLoaded = useCallback((read: AppSettings): void => {
    const loaded = withLiveLayout(read);
    confirmedRef.current = loaded;
    setSettings(loaded);
    hydrateStoresFromLoad(read, loaded);
  }, []);

  const adoptConfirmed = useCallback((saved: AppSettings): void => {
    const confirmed = withLiveLayout(saved);
    confirmedRef.current = confirmed;
    setSettings(confirmed);
    useUiStore.getState().setLoadedSettings(confirmed);
  }, []);

  const settleWrite = (seq: number, validated: AppSettings): void => {
    const previous = confirmedRef.current;
    const confirmed = withLiveLayout(validated);
    confirmedRef.current = confirmed;
    syncStoresAfterConfirmedWrite(validated, previous);
    // Re-probing here, rather than waiting for the next periodic refresh, is
    // what stops a session created straight afterwards from being opened
    // against the previous server's model list.
    if (localProviderSettingsChanged(validated, previous)) {
      pendingRef.current = onLocalProviderChanged();
    }
    if (seq === writeSequenceRef.current) {
      useUiStore.getState().setLoadedSettings(confirmed);
      feedback.announce('Settings saved on this device.');
    }
  };

  const rollBack = (seq: number, caught: Error | null): void => {
    if (seq !== writeSequenceRef.current) return;
    feedback.fail(caught === null ? 'Failed to save settings. Changes were not saved.' : caught.message);
    const rollback = withLiveLayout(confirmedRef.current);
    setSettings(rollback);
    restoreStoresTo(rollback);
  };

  const change = (edited: AppSettings): void => {
    // Section edits are derived from the loaded snapshot, so the live layout
    // is reapplied before this complete document is shown or written.
    const optimistic = withLiveLayout(edited);
    const seq = ++writeSequenceRef.current;
    setSettings(optimistic);
    feedback.clear();
    showOptimisticSettings(optimistic);
    const write = enqueueSettingsWrite(() => withLiveLayout(edited));
    pendingRef.current = write.then(() => undefined, () => undefined);
    void reportRejection(
      write.then((validated) => { settleWrite(seq, validated); }),
      (caught) => { rollBack(seq, caught); },
    );
  };

  const whenSaved = useCallback((): Promise<void> => pendingRef.current, []);

  return { settings, adoptLoaded, adoptConfirmed, change, whenSaved };
}
