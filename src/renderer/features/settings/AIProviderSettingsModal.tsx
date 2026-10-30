import { useEffect, useState, useRef } from 'react';
import type { AppSettings } from '@shared/schemas/settings';
import type { SettingsRailId } from '../../stores/use-ui-store';
import { AppIcon } from '../../components/AppIcon';
import { Button } from '../../components/ui/button';
import { EXIT_MS, phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { AIProvidersSection } from './AIProvidersSection';
import { ConversationNamingSection } from './ConversationNamingSection';
import { SettingsSectionPanel } from './SettingsSectionPanel';
import { deriveProviderRows, loadingProviderRows, openRouterCredentialState } from './provider-rows';
import {
  SETTINGS_RAIL,
  isSettingsRailEntryActive,
  settingsRailEntry,
  settingsRailProviderId,
  type SettingsSection,
} from './settings-rail';
import { useAgentResources } from './use-agent-resources';
import { useChatGptSignIn } from './use-chatgpt-sign-in';
import { useDebugLogExport } from './use-debug-log-export';
import { useDialogFocus } from './use-dialog-focus';
import { useLocalConnection } from './use-local-connection';
import { useOpenRouterSettings } from './use-openrouter-settings';
import { useProviderStatuses } from './use-provider-statuses';
import { useSettingsDocument } from './use-settings-document';
import { useSettingsFeedback } from './use-settings-feedback';
import { useSettingsLoad } from './use-settings-load';
import './settings-design.css';

/** The dialog's exit, shared by every menu and dialog (`--dur-exit`). */
export const DIALOG_EXIT_MS = EXIT_MS;

/**
 * The Settings dialog: section navigation, layout and focus.
 *
 * Each feature owns its own loading, saving, errors and cancellation in its own
 * hook; this component only wires them to the sections that show them. The
 * shared settings-document write ordering lives in `useSettingsDocument`.
 */
export function AIProviderSettingsModal({
  open,
  onClose,
  onProvidersChanged,
  initialTarget,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onProvidersChanged: () => void;
  /** Rail section this dialog opens on. */
  readonly initialTarget: SettingsRailId;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(settingsRailEntry(initialTarget).section);
  // At most one provider row is open. Lives here so switching settings
  // sections does not close the provider the reader was configuring.
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(
    settingsRailProviderId(initialTarget)
  );
  const feedback = useSettingsFeedback();
  const providers = useProviderStatuses();
  const agentResources = useAgentResources();
  const local = useLocalConnection({ adoptStatus: providers.adoptStatus, onProvidersChanged });
  const settingsDocument = useSettingsDocument({ feedback, onLocalProviderChanged: local.refresh });
  const openRouter = useOpenRouterSettings({
    feedback,
    providers,
    onProvidersChanged,
    onSaved: settingsDocument.adoptConfirmed,
  });
  const chatGpt = useChatGptSignIn({ providers, feedback, onProvidersChanged });
  const debugLog = useDebugLogExport(feedback);
  const settingsLoad = useSettingsLoad({ feedback, providers, openRouter, document: settingsDocument, agentResources });
  const dialogRef = useDialogFocus(open, onClose);
  const railRef = useRef<HTMLElement>(null);
  // Below `md` the rail is one scrolling row; keep the active section in it.
  useEffect(() => {
    const active = railRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSection]);
  // Enters from its first mount, and stays mounted, inert and hidden from
  // assistive technology while its exit runs; reduced motion skips both.
  const presence = usePopoverPresence(open, true);

  const handleSectionChange = (section: SettingsSection): void => {
    if (section !== activeSection) feedback.clearSuccess();
    setActiveSection(section);
  };

  // The open effect must read the current loader without re-running whenever a
  // render gives it a new identity: reloading mid-edit would discard drafts.
  const loadRef = useRef(settingsLoad.load);
  loadRef.current = settingsLoad.load;
  const { resetForOpen } = openRouter;
  const { clear: clearFeedback } = feedback;

  useEffect(() => {
    if (open) {
      // Each open honours the deep link it was opened with; without one this is
      // the dialog's default AI Providers section, exactly as before.
      setActiveSection(settingsRailEntry(initialTarget).section);
      setExpandedProviderId(settingsRailProviderId(initialTarget));
      resetForOpen();
      clearFeedback();
      void loadRef.current();
    }
  }, [open, initialTarget, resetForOpen, clearFeedback]);
  if (!presence.present) return null;

  const loadState = settingsLoad.state;
  const settingsReady = loadState === 'ready';
  const providerSettingsReady = settingsReady && providers.ready;
  // Retina device scale and browser zoom multiply; at that density only the
  // model metadata line tightens. The dialog itself stays centred and sized by
  // the viewport at every zoom level.
  const denseZoomLayout = typeof window !== 'undefined' && window.devicePixelRatio >= 3;
  const { settings, change } = settingsDocument;
  // Sections edit the loaded document, so nothing is written before it exists.
  const handleSettingsChange = (edited: AppSettings): void => {
    if (settingsReady) change(edited);
  };

  const handleDone = async () => {
    if (openRouter.busy || loadState === 'loading') return;
    const outcome = await openRouter.commit(activeSection === 'ai');
    if (outcome === 'done') onClose();
    // A draft Done refused may sit in a collapsed row or another section: open
    // it, so its field (focused by the commit) and its message are in view.
    if (outcome === 'invalid') {
      setActiveSection('ai');
      setExpandedProviderId('openrouter');
    }
  };

  const codexProvider = providers.providers.find((p) => p.id === 'codex');
  // Rows report a checked status or say they are still checking; settings
  // readiness alone never promotes an unchecked provider to "Not installed".
  const providerRows = providers.ready
    ? deriveProviderRows({
        providers: providers.providers,
        profiles: agentResources.profiles,
        openRouterCredential: openRouterCredentialState({
          configured: openRouter.configured,
          keyPreview: openRouter.keyPreview,
        }),
      })
    : loadingProviderRows();
  /** At most one provider row is open, as in design 5a. */
  const handleProviderToggle = (id: string): void => {
    setExpandedProviderId((current) => (current === id ? null : id));
  };
  const handleAddProvider = (): void => {
    setExpandedProviderId('openrouter');
    openRouter.requestKeyFocus();
  };

  return (
    <div
      data-testid="settings-dialog-scrim"
      {...phaseAttributes(presence.phase)}
      className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        ref={dialogRef}
        data-phase={presence.phase}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        data-testid="ai-providers-settings-modal"
        // A fixed height rather than a maximum: switching sections scrolls the
        // content inside the dialog instead of resizing the dialog around it.
        className="ui-dialog settings-design flex h-[min(90vh,52rem)] w-full min-w-0 max-w-4xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-primary p-2 shadow-xl md:p-5"
      >
        <div className="flex min-w-0 items-start justify-between gap-4 border-b border-border-subtle pb-3 md:pb-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="settings-title">Settings</h2>
            <p className="settings-description hidden break-words md:block">Reader preferences, appearance, AI providers, and agent sandboxing</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary"
          >
            <AppIcon name="close" size={15} />
          </button>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 py-1 md:flex-row md:gap-5 md:py-3">
          <nav ref={railRef} aria-label="Settings sections" className="settings-rail mb-3 flex max-h-6 w-full min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-border-subtle pb-1 md:mb-0 md:max-h-none md:w-40 md:flex-col md:space-y-1 md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-r md:pb-0 md:pr-3">
            {SETTINGS_RAIL.map((entry) => (
              <button key={entry.id} type="button" data-testid={`settings-rail-${entry.id}`} disabled={!settingsReady} aria-pressed={isSettingsRailEntryActive(entry, activeSection)} onClick={() => { handleSectionChange(entry.section); }} className="w-auto shrink-0 rounded-md px-2.5 py-0 text-left text-xs text-text-secondary hover:bg-bg-surface hover:text-text-primary aria-pressed:bg-accent-muted aria-pressed:font-semibold aria-pressed:text-text-primary disabled:opacity-50 md:w-full md:py-2">{entry.label}</button>
            ))}
          </nav>
          <div data-testid="settings-content" className="settings-content min-h-0 min-w-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto">
          {loadState === 'loading' && <p data-testid="settings-loading" role="status" aria-live="polite" aria-busy="true" className="rounded-md border border-border-subtle bg-bg-surface p-3 text-xs text-text-secondary">Loading settings…</p>}
          {loadState === 'error' && <div data-testid="settings-load-error" role="alert" className="mb-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger"><p>{feedback.error ?? 'Settings could not be loaded.'}</p><button type="button" onClick={() => { void settingsLoad.load(); }} className="mt-2 rounded border border-danger/40 px-2 py-1 font-medium hover:bg-danger/10">Retry loading settings</button></div>}
          <fieldset disabled={!settingsReady} className="contents">

          {activeSection !== 'ai' && <SettingsSectionPanel section={activeSection} settings={settings} availableProfiles={agentResources.profiles} workingDirectories={agentResources.workingDirectories} onChange={handleSettingsChange} />}
          {activeSection === 'ai' && (
            <>
              <AIProvidersSection
                rows={providerRows}
                expandedId={expandedProviderId}
                onToggle={handleProviderToggle}
                onAddProvider={openRouter.configured || !settingsReady ? null : handleAddProvider}
                openRouter={openRouter.panelProps(denseZoomLayout)}
                agent={{
                  settings,
                  availableProfiles: agentResources.profiles,
                  onProfilesRefreshed: agentResources.setProfiles,
                  workingDirectories: agentResources.workingDirectories,
                  onSettingsChange: handleSettingsChange,
                  settingsReady: providerSettingsReady,
                  signingInChatGpt: chatGpt.signingIn,
                  onChatGptSignIn: () => { void chatGpt.signIn(); },
                  codexInstalled: codexProvider?.installed === true,
                }}
                local={{
                  settings,
                  onSettingsChange: handleSettingsChange,
                  status: providers.providers.find((provider) => provider.id === 'local'),
                  settingsReady: providerSettingsReady,
                  checking: local.checking,
                  onCheckConnection: () => { void local.check(settingsDocument.whenSaved()); },
                }}
              />
              <ConversationNamingSection
                settings={settings}
                onSettingsChange={handleSettingsChange}
                providers={providers.providers}
                providersReady={providers.ready}
                settingsReady={settingsReady}
              />
            </>
          )}
          </fieldset>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2 md:pt-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="export-debug-log-button"
              onClick={() => { void debugLog.exportLog(); }}
              disabled={debugLog.exporting || loadState === 'loading'}
              aria-describedby="debug-log-export-help"
            >
              {debugLog.exporting ? 'Exporting…' : 'Export Debug Log'}
            </Button>
            <span id="debug-log-export-help" className="sr-only">Opens a native Save dialog and exports sanitized bounded application diagnostics.</span>
          </div>
          {/* One feedback line beside Done: it never pushes the section content,
              so a save (or a theme cross-fade) cannot shift what is being read. */}
          <div data-testid="settings-feedback" className="flex min-w-0 flex-1 justify-end">
            {loadState !== 'error' && feedback.error ? (
              <p id="settings-error" role="alert" aria-live="assertive" className="min-w-0 rounded-md bg-danger/10 px-2 py-1 text-xs text-danger">{feedback.error}</p>
            ) : (
              <p role="status" aria-live="polite" className="min-w-0 truncate text-xs text-text-secondary">{feedback.successMessage}</p>
            )}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void handleDone(); }}
            disabled={openRouter.busy || loadState === 'loading'}
            aria-busy={openRouter.saving}
          >
            {openRouter.saving ? 'Saving…' : 'Done'}
          </Button>
        </div>
      </div>
    </div>
  );
}
