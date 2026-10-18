import { useCallback, useRef, useState, type ReactElement } from 'react';
import type { AgentSession } from '@shared/types/agent';
import { AppIcon } from '../../components/AppIcon';
import { phaseAttributes, usePopoverPresence } from '../../components/ui/popover-presence';
import { useAnchoredPosition } from '../../components/ui/use-anchored-position';
import { AgentSessionItems, SESSION_PANEL_CLASS } from './AgentSessionItems';
import { useOutsidePointerDismiss } from './use-outside-dismiss';

type AgentRunMenuProps = {
  readonly sessions: readonly AgentSession[];
  readonly activeSessionId: string;
  readonly profileName: (profileId: string) => string;
  readonly onSelect: (sessionId: string) => void;
};

/**
 * Reference 6b ends the run header's first row with a compact `⋯` control
 * rather than a second row of session state, so the header stays two rows at
 * every width. Session navigation lives behind it.
 *
 * This is the disclosure pattern, not a menu widget: the trigger owns
 * `aria-expanded` and `aria-controls`, the region stays mounted so the
 * relationship always resolves, and Escape closes it and returns focus to the
 * trigger. Selecting a run also closes it, because the header behind it is
 * about to describe a different run.
 */
export function AgentRunMenu({
  sessions,
  activeSessionId,
  profileName,
  onSelect,
}: AgentRunMenuProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const presence = usePopoverPresence(expanded);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  // Fixed coordinates from the trigger, so the companion's edge cannot clip it.
  const anchorStyle = useAnchoredPosition(triggerRef, regionRef, 'bottom');

  const close = (): void => {
    setExpanded(false);
    triggerRef.current?.focus();
  };

  // A press outside the trigger and its panel closes the panel without taking
  // focus back, so the control the user is pressing keeps it.
  const collapse = useCallback(() => { setExpanded(false); }, []);
  useOutsidePointerDismiss(expanded, containerRef, collapse);

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      data-testid="agent-run-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="agent-run-menu-button"
        aria-label="All sessions"
        aria-expanded={expanded}
        aria-controls="agent-run-menu-region"
        onClick={() => { setExpanded((current) => !current); }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-surface hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <AppIcon name="more-horizontal" size={15} />
      </button>
      <div
        ref={regionRef}
        id="agent-run-menu-region"
        hidden={!presence.present}
        {...phaseAttributes(presence.phase)}
        role="group"
        aria-label="All sessions"
        style={anchorStyle}
        className={SESSION_PANEL_CLASS}
      >
        <AgentSessionItems
          sessions={sessions}
          activeSessionId={activeSessionId}
          profileName={profileName}
          onSelect={(sessionId) => {
            setExpanded(false);
            onSelect(sessionId);
          }}
        />
      </div>
    </div>
  );
}
