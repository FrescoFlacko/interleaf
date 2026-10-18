import { useState, type ReactElement } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { Button } from '../../components/ui/button';
import { useLibraryStore } from '../../stores/use-library-store';
import { useOnboardingStore } from '../../stores/use-onboarding-store';

/**
 * The bookend stage bodies for the guided onboarding wizard.
 *
 * Detection (Step 2) and defaults (Step 3) own their own modules; what is left
 * here is the two stages that only speak. Copy is deliberately specific about
 * what leaves the machine and about what is optional (§7).
 */

export function WelcomeStage(): ReactElement {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-text-secondary">
      <p>
        Interleaf is a reader first. Opening documents, highlighting and taking notes happen on this
        machine and need no account and no AI.
      </p>
      <p>
        If you connect an AI provider, the text you ask about is sent to that provider. You can skip
        this now and set it up later from Settings.
      </p>
      <p className="text-text-primary">Nothing on the next screens is required to start reading.</p>
    </div>
  );
}

export function ImportStage(): ReactElement {
  const openFileDialog = useLibraryStore((state) => state.openFileDialog);
  const setWebImportModalOpen = useLibraryStore((state) => state.setWebImportModalOpen);
  const acknowledgeStage = useOnboardingStore((state) => state.acknowledgeStage);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseFile = async (): Promise<void> => {
    setBusy(true);
    setImportError(null);
    try {
      const result = await openFileDialog();
      // A cancelled dialog returns nothing imported and leaves the stage as it
      // was; only a real failure is reported.
      if (result !== null && result.failed.length > 0) {
        setImportError(result.failed[0]?.error ?? 'That document could not be imported.');
        return;
      }
      if (result !== null && result.imported.length > 0) acknowledgeStage('import');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'That document could not be imported.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-text-secondary">
        Add your first document, or start with the library you already have. Importing is local: the
        file is copied into Interleaf&rsquo;s own storage.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          data-testid="onboarding-choose-file"
          onClick={() => { void chooseFile(); }}
        >
          <AppIcon name="import-from-files" size={13} /> Choose file…
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="onboarding-import-web"
          onClick={() => {
            acknowledgeStage('import');
            setWebImportModalOpen(true);
          }}
        >
          <AppIcon name="import-from-web" size={13} /> Save a web article
        </Button>
      </div>
      {importError !== null && (
        <p role="alert" className="text-xs text-danger" data-testid="onboarding-import-error">
          {importError}
        </p>
      )}
      <p className="text-xs text-text-secondary">
        You can skip this and import later — <em>Start reading</em> finishes setup either way.
      </p>
    </div>
  );
}
