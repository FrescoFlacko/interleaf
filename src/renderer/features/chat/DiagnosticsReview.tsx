import type { ReactElement, RefObject } from 'react';
import type { DiagnosticsPacket } from '@shared/schemas/diagnostics';
import { Button } from '../../components/ui/button';
import { Separator } from '../../components/ui/separator';
import { useDiagnosticsStore } from '../../stores/use-diagnostics-store';
import { DiagnosticsAnalysis } from './DiagnosticsAnalysis';
import { DiagnosticsDisclosure, DiagnosticsViewer } from './DiagnosticsDisclosure';
import { DiagnosticsNotice } from './DiagnosticsNotice';
import { summarizePacket, type SummaryLine } from './diagnostics-summary';

type ReviewProps = {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onCollectAgain: () => void;
};

/**
 * The reviewed report: a readable summary of the packet, the description as
 * main sanitized it, the exact packet and report file on request, and Export,
 * which needs no AI. Optional analysis follows, kept apart from these facts.
 */
export function DiagnosticsReview({ headingRef, onCollectAgain }: ReviewProps): ReactElement | null {
  const step = useDiagnosticsStore((state) => state.step);
  const collected = useDiagnosticsStore((state) => state.collected);
  const report = useDiagnosticsStore((state) => state.report);
  const notice = useDiagnosticsStore((state) => state.notice);
  const exportReport = useDiagnosticsStore((state) => state.exportReport);
  const discard = useDiagnosticsStore((state) => state.discard);
  if (collected === null || report === null) return null;
  const idle = step === 'ready';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h5 ref={headingRef} tabIndex={-1} className="rounded text-xs font-semibold text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          Report ready to review
        </h5>
        <PacketSummaryList packet={collected.packet} />
        <div className="flex flex-col gap-1">
          <h6 className="text-xs font-medium text-text-primary">Your description, as it will be shared</h6>
          {report.issue.length === 0
            ? <p className="text-xs text-text-secondary">No description added.</p>
            : <p data-testid="diagnostics-shared-issue" className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">{report.issue}</p>}
        </div>
        <DiagnosticsDisclosure label="Show the exact collected data">
          <DiagnosticsViewer testId="diagnostics-packet" label="Collected diagnostics packet" text={collected.packetText} />
        </DiagnosticsDisclosure>
        <DiagnosticsDisclosure label="Show the full report file">
          <p className="text-2xs leading-relaxed text-text-secondary">
            This is exactly what Export saves. Interleaf cannot guarantee it identifies no one, so read it before sharing it.
          </p>
          <DiagnosticsViewer testId="diagnostics-report" label="Diagnostics report file" text={report.text} />
        </DiagnosticsDisclosure>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" data-testid="diagnostics-export" onClick={() => { void exportReport(); }} disabled={!idle} aria-busy={step === 'exporting'}>
            {step === 'exporting' ? 'Exporting…' : 'Export report…'}
          </Button>
          <Button variant="ghost" size="sm" data-testid="diagnostics-recollect" onClick={onCollectAgain} disabled={!idle}>Collect again</Button>
          <Button variant="ghost" size="sm" data-testid="diagnostics-discard" onClick={discard} disabled={!idle}>Discard</Button>
        </div>
        <p className="text-2xs leading-relaxed text-text-secondary">
          {report.analyzed
            ? 'Saves the report, including the AI analysis, as a Markdown file where you choose. Nothing is uploaded.'
            : 'Saves the report as a Markdown file where you choose. Nothing is uploaded.'}
        </p>
        {notice !== null && notice.kind !== 'analysis-failed' && <DiagnosticsNotice notice={notice} />}
      </div>
      <Separator />
      <DiagnosticsAnalysis key={collected.handle} providers={collected.providers} />
    </div>
  );
}

function PacketSummaryList({ packet }: { readonly packet: DiagnosticsPacket }): ReactElement {
  const summary = summarizePacket(packet);
  return (
    <dl data-testid="diagnostics-summary" className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      <dt className="font-medium text-text-primary">Interleaf</dt>
      <dd className="text-text-secondary">{summary.app}</dd>
      <dt className="font-medium text-text-primary">System</dt>
      <dd className="text-text-secondary">{summary.system}</dd>
      <dt className="font-medium text-text-primary">AI providers</dt>
      <dd className="text-text-secondary"><SummaryLines lines={summary.providers} empty="No providers were checked." /></dd>
      <dt className="font-medium text-text-primary">Recorded problems</dt>
      <dd className="flex flex-col gap-1 text-text-secondary">
        {summary.signals.length > 0 && <SummaryLines lines={summary.signals} empty="" />}
        {summary.logNote !== null && <span className="text-2xs leading-relaxed">{summary.logNote}</span>}
      </dd>
    </dl>
  );
}

function SummaryLines({ lines, empty }: { readonly lines: readonly SummaryLine[]; readonly empty: string }): ReactElement {
  if (lines.length === 0) return <span>{empty}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line.key} className="break-words">
          <span className="text-text-primary">{line.label}</span>: {line.detail}
        </li>
      ))}
    </ul>
  );
}
