import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ONBOARDING_STAGES, type OnboardingStage } from '@shared/constants/onboarding';
import { AppIcon } from '../../components/AppIcon';
import { Button } from '../../components/ui/button';
import { useOnboardingStore, type OnboardingExitReason } from '../../stores/use-onboarding-store';
import type { OnboardingProviderRow } from './onboarding-rows';
import { useOnboardingRows } from './use-onboarding-rows';
import { useOnboardingDialogFocus } from './use-onboarding-dialog-focus';
import { ImportStage, WelcomeStage } from './stages';
import { DiscoverStage } from './DiscoverStage';
import { DefaultsStage } from './DefaultsStage';

/**
 * The guided onboarding wizard.
 *
 * One modal surface over the existing dialog primitives. Three properties are
 * structural rather than cosmetic:
 *
 * - **No stage is a gate.** *Continue* is never disabled by an unfinished
 *   check, an unconnected provider or a skipped import; the only thing that
 *   ends the flow is the user's own choice.
 * - **Every exit is a suppression.** Escape, the close button, *Skip AI* and
 *   *Finish later* all record a status that stops the wizard reopening by
 *   itself (§5.3). Nothing here schedules a reappearance.
 * - **Stage changes are announced politely**, not asserted, so a reader is not
 *   interrupted mid-sentence when a provider row settles behind the heading.
 */

const STAGE_TITLES: Readonly<Record<OnboardingStage, string>> = {
  welcome: 'Welcome to Interleaf',
  discover: 'Find your AI tools',
  connect: 'Choose your defaults',
  import: 'Add your first document',
  'first-action': 'You are ready to read',
};

/** Footer copy that explains the stage rather than labelling a control. */
const STAGE_FOOTER_NOTES: Readonly<Partial<Record<OnboardingStage, string>>> = {
  discover: 'Chat and Agent are the two modes a tool can serve.',
};

/** The four stages the modal itself renders; the fifth is a non-modal tip. */
const MODAL_STAGES: readonly OnboardingStage[] = ['welcome', 'discover', 'connect', 'import'];

function stepNumber(stage: OnboardingStage): number {
  return ONBOARDING_STAGES.indexOf(stage) + 1;
}

/** The stage-specific body, kept out of the shell that frames it. */
function StageBody({
  current,
  rows,
}: {
  readonly current: OnboardingStage;
  readonly rows: readonly OnboardingProviderRow[];
}): ReactElement | null {
  if (current === 'welcome') return <WelcomeStage />;
  if (current === 'discover') return <DiscoverStage rows={rows} />;
  if (current === 'connect') return <DefaultsStage rows={rows} />;
  if (current === 'import') return <ImportStage />;
  return null;
}

/**
 * The stage's own way out.
 *
 * Every one of these is a legitimate ending rather than an escape hatch, which
 * is why each stage offers the wording that fits what it is asking for.
 */
function StageExit({
  current,
  onClose,
  onSkipDefaults,
}: {
  readonly current: OnboardingStage;
  readonly onClose: (reason: OnboardingExitReason) => void;
  readonly onSkipDefaults: () => void;
}): ReactElement | null {
  if (current === 'welcome') {
    return (
      <Button variant="ghost" size="sm" data-testid="onboarding-start-reading" onClick={() => { onClose('dismissed'); }}>
        Start reading
      </Button>
    );
  }
  if (current === 'discover') {
    return (
      <Button variant="ghost" size="sm" data-testid="onboarding-skip-ai" onClick={() => { onClose('skip-ai'); }}>
        Skip AI setup
      </Button>
    );
  }
  if (current === 'connect') {
    return (
      <Button variant="ghost" size="sm" data-testid="onboarding-skip-defaults" onClick={onSkipDefaults}>
        Skip for now
      </Button>
    );
  }
  return null;
}

export function OnboardingWizard(): ReactElement | null {
  const open = useOnboardingStore((state) => state.open);
  const stage = useOnboardingStore((state) => state.stage);
  const openerId = useOnboardingStore((state) => state.openerId);
  const saveError = useOnboardingStore((state) => state.saveError);
  const closeWizard = useOnboardingStore((state) => state.closeWizard);
  const goToStage = useOnboardingStore((state) => state.goToStage);
  const acknowledgeStage = useOnboardingStore((state) => state.acknowledgeStage);
  const commitDefaults = useOnboardingStore((state) => state.commitDefaults);
  const rows = useOnboardingRows();

  const dialogRef = useOnboardingDialogFocus(open, () => { closeWizard('finish-later'); }, openerId);
  const [announcement, setAnnouncement] = useState('');
  const announcedStage = useRef<OnboardingStage | null>(null);

  // The live region is populated after the stage has rendered, so the
  // announcement describes a heading that already exists.
  useEffect(() => {
    if (!open) {
      announcedStage.current = null;
      setAnnouncement('');
      return;
    }
    if (announcedStage.current === stage) return;
    announcedStage.current = stage;
    setAnnouncement(`Step ${String(stepNumber(stage))} of ${String(MODAL_STAGES.length)}. ${STAGE_TITLES[stage]}`);
  }, [open, stage]);

  const index = useMemo(() => MODAL_STAGES.indexOf(stage), [stage]);
  if (!open) return null;
  // `first-action` is rendered outside the modal; reaching it means the modal
  // part of the flow is over.
  const current = index < 0 ? 'welcome' : stage;
  const position = index < 0 ? 0 : index;

  const footerNote = STAGE_FOOTER_NOTES[current];

  const advance = (): void => {
    // Step 3's Continue is the single user action that commits both defaults.
    // It is still not a gate: a failed or empty commit never blocks the flow,
    // and a failure is reported through the save-error banner.
    if (current === 'connect') void commitDefaults();
    acknowledgeStage(current);
    const next = MODAL_STAGES[position + 1];
    if (next === undefined) {
      closeWizard('completed');
      return;
    }
    goToStage(next);
  };

  /** Moves past defaults without committing anything. */
  const skipDefaults = (): void => {
    acknowledgeStage(current);
    const next = MODAL_STAGES[position + 1];
    if (next !== undefined) goToStage(next);
  };

  const goBack = (): void => {
    const previous = MODAL_STAGES[position - 1];
    if (previous !== undefined) goToStage(previous);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
        data-testid="onboarding-wizard"
        data-stage={current}
        className="flex max-h-[92vh] w-full max-w-2xl min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-primary shadow-xl"
      >
        <div className="flex min-w-0 items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-2xs font-medium uppercase tracking-[0.08em] text-text-secondary">
              Step {stepNumber(current)} of {MODAL_STAGES.length}
            </p>
            <h2 id="onboarding-title" className="text-balance text-base font-semibold text-text-primary">
              {STAGE_TITLES[current]}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => { closeWizard('finish-later'); }}
            aria-label="Close setup"
            data-testid="onboarding-close"
            className="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <AppIcon name="close" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <StageBody current={current} rows={rows} />
        </div>

        {saveError !== null && (
          <div
            role="alert"
            data-testid="onboarding-save-error"
            className="mx-5 mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {saveError} Your reading and annotations are unaffected.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="onboarding-finish-later"
              onClick={() => { closeWizard('finish-later'); }}
            >
              Finish later
            </Button>
            <StageExit current={current} onClose={closeWizard} onSkipDefaults={skipDefaults} />
          </div>
          {footerNote !== undefined && (
            <p className="min-w-0 flex-1 text-2xs leading-[1.5] text-text-secondary" data-testid="onboarding-footer-note">
              {footerNote}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {position > 0 && (
              <Button variant="outline" size="sm" data-testid="onboarding-back" onClick={goBack}>
                Back
              </Button>
            )}
            <Button variant="primary" size="sm" data-testid="onboarding-continue" onClick={advance}>
              {position === MODAL_STAGES.length - 1 ? 'Start reading' : 'Continue'}
            </Button>
          </div>
        </div>
      </div>

      <div aria-live="polite" role="status" className="sr-only" data-testid="onboarding-live-region">
        {announcement}
      </div>
    </div>
  );
}
