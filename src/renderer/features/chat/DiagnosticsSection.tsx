import { useEffect, useRef, type ReactElement } from 'react';
import { DIAGNOSTICS_LIMITS } from '@shared/schemas/diagnostics';
import { Button } from '../../components/ui/button';
import { Separator } from '../../components/ui/separator';
import { useDiagnosticsStore } from '../../stores/use-diagnostics-store';
import { DiagnosticsDisclosure } from './DiagnosticsDisclosure';
import { DiagnosticsNotice } from './DiagnosticsNotice';
import { DiagnosticsReview } from './DiagnosticsReview';

/**
 * Private diagnostics, in Settings › Advanced: describe the problem, prepare
 * and review the report, export it, and optionally ask an AI provider about it.
 *
 * Collection is local and needs neither a document nor an AI provider. Main
 * collects, sanitizes and builds every report; this panel shows exactly what
 * main returned, sends nothing until the user picks a provider and model and
 * asks, and exports only through a native save dialog. The packet and handle
 * are dropped when the panel closes.
 */
export function DiagnosticsSection(): ReactElement {
  const report = useDiagnosticsStore((state) => state.report);
  const prepare = useDiagnosticsStore((state) => state.prepare);
  const discard = useDiagnosticsStore((state) => state.discard);
  const sectionRef = useRef<HTMLElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusReviewWhenReady = useRef(false);

  // Closing Settings or leaving Advanced forgets the packet here and in main.
  useEffect(() => discard, [discard]);

  // Only an explicit Prepare moves focus, and only if the user has not moved it out of this panel meanwhile.
  useEffect(() => {
    if (report === null || !focusReviewWhenReady.current) return;
    focusReviewWhenReady.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || sectionRef.current?.contains(active) === true) reviewHeadingRef.current?.focus();
  }, [report]);

  const requestReport = (fresh: boolean): void => {
    focusReviewWhenReady.current = true;
    void prepare(fresh);
  };

  return (
    <section
      ref={sectionRef}
      aria-labelledby="settings-diagnostics-heading"
      data-testid="settings-diagnostics"
      className="mt-6 flex max-w-xl flex-col gap-4"
    >
      <Separator />
      <DiagnosticsIntro />
      <DiagnosticsDraft onPrepare={() => { requestReport(false); }} onCollectAgain={() => { requestReport(true); }} />
      {report !== null && <DiagnosticsReview headingRef={reviewHeadingRef} onCollectAgain={() => { requestReport(true); }} />}
    </section>
  );
}

function DiagnosticsIntro(): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <h4 id="settings-diagnostics-heading" className="text-sm font-semibold text-text-primary">Private diagnostics</h4>
      <p className="text-xs leading-relaxed text-text-secondary">
        Prepare a short technical report to help find problems with providers and sign-in, imports, startup and updates.
      </p>
      <p className="text-xs leading-relaxed text-text-secondary">
        Your documents, notes, chats and credentials are never included, and the report stays on this device unless you
        export it or ask an AI provider to analyze it.
      </p>
      <DiagnosticsDisclosure label="What the report includes">
        <div className="flex flex-col gap-2 text-2xs leading-relaxed text-text-secondary">
          <p>
            <span className="font-medium text-text-primary">Included: </span>
            Interleaf&apos;s version and runtime versions, the operating system family and architecture, whether Interleaf is
            installed or a development build, each AI provider&apos;s readiness, counts of local log records by category, level
            and known failure code, and the description you write, after Interleaf removes common secrets, email addresses and
            file paths.
          </p>
          <p>
            <span className="font-medium text-text-primary">Never included: </span>
            raw log messages, settings, credentials, library contents, documents, notes, chats, file paths and account names.
          </p>
          <p>
            Checking provider readiness may contact providers you have configured. The report itself leaves this device only
            when you export it or choose to analyze it.
          </p>
        </div>
      </DiagnosticsDisclosure>
    </div>
  );
}

type DraftProps = { readonly onPrepare: () => void; readonly onCollectAgain: () => void };

/** The description stays editable beside the review; changing it retires the review until the report is updated. */
function DiagnosticsDraft({ onPrepare, onCollectAgain }: DraftProps): ReactElement {
  const step = useDiagnosticsStore((state) => state.step);
  const reviewed = useDiagnosticsStore((state) => state.report !== null);
  const issue = useDiagnosticsStore((state) => state.issue);
  const setIssue = useDiagnosticsStore((state) => state.setIssue);
  // Editing waits while main works, so its sanitized copy never overwrites newer typing.
  const editable = step === 'idle' || step === 'ready';

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        <span className="font-medium text-text-primary">Describe the problem (optional)</span>
        <textarea
          data-testid="diagnostics-issue"
          value={issue}
          maxLength={DIAGNOSTICS_LIMITS.issueMaxLength}
          rows={3}
          disabled={!editable}
          onChange={(event) => { setIssue(event.target.value); }}
          aria-describedby="diagnostics-issue-help"
          className="block w-full rounded-md border border-border-strong bg-bg-primary p-2 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
          placeholder="For example: Claude shows as not signed in after I sign in from the terminal."
        />
        <span id="diagnostics-issue-help" className="text-2xs leading-relaxed">
          {issue.length}/{DIAGNOSTICS_LIMITS.issueMaxLength}. Common secrets, email addresses and file paths are removed before
          you review the report. Leave out anything else you would not share.
        </span>
      </label>
      {!reviewed && <DraftActions onPrepare={onPrepare} onCollectAgain={onCollectAgain} />}
    </div>
  );
}

/**
 * Once a packet exists, Collect again stays beside Update report, so an expired
 * packet can be replaced without losing the edited description.
 */
function DraftActions({ onPrepare, onCollectAgain }: DraftProps): ReactElement {
  const step = useDiagnosticsStore((state) => state.step);
  const collected = useDiagnosticsStore((state) => state.collected);
  const notice = useDiagnosticsStore((state) => state.notice);
  const discard = useDiagnosticsStore((state) => state.discard);
  const editable = step === 'idle' || step === 'ready';
  const working = step === 'collecting' || step === 'reviewing';

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" data-testid="diagnostics-prepare" onClick={onPrepare} disabled={!editable} aria-busy={working}>
          {step === 'collecting' ? 'Collecting…' : step === 'reviewing' ? 'Preparing…' : collected === null ? 'Prepare report' : 'Update report'}
        </Button>
        {collected !== null && (
          <>
            <Button variant="ghost" size="sm" data-testid="diagnostics-recollect" onClick={onCollectAgain} disabled={!editable}>
              Collect again
            </Button>
            <Button variant="ghost" size="sm" data-testid="diagnostics-discard" onClick={discard} disabled={!editable}>
              Discard
            </Button>
          </>
        )}
      </div>
      {working && (
        <p role="status" aria-live="polite" className="text-xs text-text-secondary">
          {step === 'collecting' ? 'Collecting diagnostics on this device…' : 'Preparing the report for review…'}
        </p>
      )}
      {!working && collected !== null && notice === null && (
        <p className="text-2xs leading-relaxed text-text-secondary">The description changed. Update the report to review it again.</p>
      )}
      {notice !== null && <DiagnosticsNotice notice={notice} />}
    </>
  );
}
