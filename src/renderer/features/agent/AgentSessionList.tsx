import type { ReactElement } from 'react';
import type { AgentSession } from '@shared/types/agent';
import { AgentDisclosure } from './AgentDisclosure';
import { AgentSessionItems, SESSION_PANEL_CLASS } from './AgentSessionItems';

type AgentSessionListProps = {
  readonly sessions: readonly AgentSession[];
  readonly activeSessionId: string | null;
  readonly profileName: (profileId: string) => string;
  readonly onSelect: (sessionId: string) => void;
};

/**
 * Reference 6a puts "All sessions" in the panel header as a chip, so the
 * history never competes with the task for vertical space. It is one
 * disclosure with one heading, and the list opens as an overlay anchored to
 * the chip. The chip is shown before the first run too: history is a permanent
 * part of the header, and its panel says so when there is nothing to list.
 */
export function AgentSessionList({
  sessions,
  activeSessionId,
  profileName,
  onSelect,
}: AgentSessionListProps): ReactElement {
  return (
    <section
      aria-labelledby="agent-session-list-heading"
      data-testid="agent-session-list"
      className="relative shrink-0"
    >
      <AgentDisclosure
        regionId="agent-session-list-region"
        label="All sessions"
        headingId="agent-session-list-heading"
        containerClassName="agent-session-chip"
        overlay
        regionClassName={SESSION_PANEL_CLASS}
      >
        <AgentSessionItems
          sessions={sessions}
          activeSessionId={activeSessionId}
          profileName={profileName}
          onSelect={onSelect}
        />
      </AgentDisclosure>
    </section>
  );
}
