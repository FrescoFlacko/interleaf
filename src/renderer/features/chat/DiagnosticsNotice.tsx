import type { ReactElement } from 'react';
import type { DiagnosticsFailure } from '@shared/schemas/diagnostics';
import { cn } from '../../components/ui/cn';
import type { DiagnosticsNotice as Notice } from '../../stores/use-diagnostics-store';

const FAILURE_COPY: Record<DiagnosticsFailure, string> = {
  'provider-unavailable': 'That provider is no longer ready to analyze without tools. Choose Collect again to refresh the list.',
  'model-unavailable': 'That model is no longer offered by the provider. Choose another model.',
  busy: 'Another diagnostics analysis is still running. Wait for it to finish or cancel it.',
  timeout: 'The provider took too long to answer. Try again, or export the report without an analysis.',
  'too-long': 'The provider\'s answer was longer than diagnostics allow, so it was not used.',
  empty: 'The provider returned no usable answer.',
  'provider-failed': 'The provider could not complete the analysis. Check its connection in AI Providers, then try again.',
  cancelled: 'Analysis cancelled. Nothing from it was kept.',
};

/** Main's allowlisted wording names an action this panel no longer shows. */
const RENAMED_RECOVERY: Readonly<Record<string, string>> = {
  'This diagnostics report has expired. Run diagnostics again.': 'This diagnostics report has expired. Choose Collect again to prepare a new one.',
};

function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case 'error': return RENAMED_RECOVERY[notice.message] ?? notice.message;
    case 'analysis-failed': return FAILURE_COPY[notice.reason];
    case 'exported': return `Saved ${notice.fileName}. Review it before sharing it with anyone.`;
    case 'export-cancelled': return 'Export cancelled. Nothing was saved.';
  }
}

/** A cancelled analysis is the user's own choice, so it reads as status, not an error. */
function isFailure(notice: Notice): boolean {
  return notice.kind === 'error' || (notice.kind === 'analysis-failed' && notice.reason !== 'cancelled');
}

/** One line of outcome copy under the action that produced it. Main's wording is shown only when allowlisted. */
export function DiagnosticsNotice({ notice }: { readonly notice: Notice }): ReactElement {
  const failed = isFailure(notice);
  return (
    <p
      role={failed ? 'alert' : 'status'}
      data-testid="diagnostics-notice"
      className={cn('text-xs leading-relaxed', failed ? 'rounded-md bg-danger/10 p-2 text-danger' : 'text-text-secondary')}
    >
      {noticeText(notice)}
    </p>
  );
}
