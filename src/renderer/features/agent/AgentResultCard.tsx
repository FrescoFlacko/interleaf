import { useState, type ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { MarkdownContent } from '../../components/markdown/MarkdownContent';
import { Badge, BadgeDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { CardLabel } from '../../components/ui/card';
import { agentOutcomeLine } from './agent-follow-ups';
import { sessionStatusLabel, sessionStatusTone, truncateForDisplay } from './agent-format';

type AgentResultCardProps = {
  readonly session: AgentSessionDetail;
  readonly report: string;
  readonly actionsReady: boolean;
};

/**
 * The run's result, first (DESIGN.md, Output first): its status, the final
 * report and an outcome line built only from the review main computed. The
 * report is agent output, so it goes through the sanitized Markdown path, which
 * keeps raw HTML and images inert.
 */
export function AgentResultCard({ session, report, actionsReady }: AgentResultCardProps): ReactElement {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const outcome = agentOutcomeLine(session.environment);
  const copy = async (): Promise<void> => {
    const result = await useAgentStore.getState().copyResult();
    setCopyStatus(result?.copied === true
      ? `Copied report (${String(result.characterCount)} chars) to clipboard.`
      : 'Copy failed.');
  };

  return (
    <section
      aria-label="Agent result"
      data-testid="agent-result-card"
      className="mt-3 flex shrink-0 flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-surface px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CardLabel>Result</CardLabel>
        <Badge size="pill" tone={sessionStatusTone(session.status)}>
          <BadgeDot />
          {sessionStatusLabel(session.status)}
        </Badge>
        {actionsReady && (
          <Button size="inline" variant="link" className="ml-auto" data-testid="agent-copy-result-button" onClick={() => { void copy(); }}>
            Copy Result
          </Button>
        )}
      </div>
      <div
        data-testid="agent-final-report"
        className="agent-result-report companion-readable companion-readable-xs max-h-[min(16rem,28vh)] min-w-0 overflow-y-auto leading-[1.6] break-words text-text-primary"
      >
        <MarkdownContent content={truncateForDisplay(report, 8_000)} diagrams />
      </div>
      {outcome !== null && (
        <p data-testid="agent-result-outcome" className="agent-mono text-2xs leading-[1.3] text-text-secondary">{outcome}</p>
      )}
      {/* Mounted before any message so screen readers announce the first one. */}
      <div aria-live="polite" className="contents">
        {copyStatus !== null && (
          <span className="text-2xs text-text-secondary" data-testid="agent-copy-status">{copyStatus}</span>
        )}
      </div>
    </section>
  );
}
