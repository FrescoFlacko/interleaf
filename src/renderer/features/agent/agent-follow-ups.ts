import type { AgentSession } from '@shared/types/agent';
import type { AgentSessionEnvironment } from '@shared/types/agent-environment';
import type { AgentActivityEntry } from './agent-activity-groups';

export type AgentFollowUp = {
  readonly kind: 'review' | 'explain' | 'tests' | 'retry';
  readonly label: string;
  readonly prompt: string;
};

const MAX_FOLLOW_UPS = 3;
const UNSUCCESSFUL = new Set<AgentSession['status']>(['failed', 'cancelled', 'interrupted']);

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * Next steps offered in the resume field once a run has ended (DESIGN.md,
 * Follow up). They are derived only from what the session records: Retry after
 * a run that did not complete, Review when files actually changed, and then
 * the general nudges. A chip only fills the field; it never resumes the run.
 */
export function deriveAgentFollowUps(
  session: Pick<AgentSession, 'status' | 'userPrompt'>,
  environment: Pick<AgentSessionEnvironment, 'changedFiles'> | null
): readonly AgentFollowUp[] {
  const candidates: AgentFollowUp[] = [];
  if (UNSUCCESSFUL.has(session.status)) {
    candidates.push({
      kind: 'retry',
      label: 'Retry',
      prompt: `The previous attempt did not finish. Try the task again:\n\n${session.userPrompt}`,
    });
  }
  const changedCount = environment?.changedFiles.length ?? 0;
  if (changedCount > 0) {
    candidates.push({
      kind: 'review',
      label: 'Review the changes',
      prompt: `Review the ${plural(changedCount, 'changed file', 'changed files')} for mistakes, regressions and missing edge cases.`,
    });
  }
  candidates.push(
    { kind: 'explain', label: 'Explain the result', prompt: 'Explain what you did, why, and anything left unfinished.' },
    { kind: 'tests', label: 'Add or run tests', prompt: 'Add or update tests that cover this change, then run them and report the results.' }
  );
  return candidates.slice(0, MAX_FOLLOW_UPS);
}

/**
 * The Result card's outcome line, built only from the review main computed:
 * the changed-file count and the recorded test results. Nothing is inferred
 * when the run has no environment.
 */
export function agentOutcomeLine(environment: Pick<AgentSessionEnvironment, 'changedFiles' | 'tests'> | null): string | null {
  if (environment === null) return null;
  const parts = [plural(environment.changedFiles.length, 'changed file', 'changed files')];
  const passed = environment.tests.filter((test) => test.status === 'passed').length;
  const failed = environment.tests.filter((test) => test.status === 'failed').length;
  if (environment.tests.length > 0) parts.push(`tests ${String(passed)} passed, ${String(failed)} failed`);
  return parts.join(' · ');
}

const FINAL_REPORT_MARKER = 'Final report shown above.';

/**
 * The report is shown once. When the Result card above the feed carries it,
 * each final-output row keeps its place in the timeline but only as a one-line
 * marker, so the report text is never repeated.
 */
export function markReportShownAbove(
  entries: readonly AgentActivityEntry[],
  finalReport: string | null
): readonly AgentActivityEntry[] {
  if (finalReport === null) return entries;
  return entries.map((entry) =>
    entry.kind === 'single' && entry.activity.kind === 'final'
      ? { ...entry, activity: { ...entry.activity, text: FINAL_REPORT_MARKER } }
      : entry
  );
}
