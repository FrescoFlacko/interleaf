import type { ReactElement } from 'react';
import type { AgentSessionDetail } from '@shared/types/agent';
import { FollowUpChip } from '../../components/companion/FollowUpChip';
import { deriveAgentFollowUps } from './agent-follow-ups';

type AgentResumeFollowUpsProps = {
  readonly session: AgentSessionDetail;
  readonly disabled: boolean;
  /** Places the suggestion in the resume field. It never resumes the run. */
  readonly onFill: (prompt: string) => void;
};

/** Suggested next steps for a run that has ended (DESIGN.md, Follow up). */
export function AgentResumeFollowUps({ session, disabled, onFill }: AgentResumeFollowUpsProps): ReactElement {
  return (
    <div role="group" aria-label="Suggested follow-ups" data-testid="agent-follow-ups" className="agent-follow-ups">
      {deriveAgentFollowUps(session, session.environment).map((followUp) => (
        <FollowUpChip
          key={followUp.kind}
          data-kind={followUp.kind}
          disabled={disabled}
          title="Fills the follow-up field; nothing is started."
          onClick={() => { onFill(followUp.prompt); }}
        >
          {followUp.label}
        </FollowUpChip>
      ))}
    </div>
  );
}
