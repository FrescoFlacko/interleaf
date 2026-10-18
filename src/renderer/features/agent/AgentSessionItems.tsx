import type { ReactElement } from 'react';
import type { AgentSession } from '@shared/types/agent';
import { AppIcon } from '../../components/AppIcon';
import { MENU_CHECK_SLOT_CLASS, MENU_ITEM_TWO_LINE_CLASS, MENU_SURFACE_CLASS } from '../../components/ui/popover-presence';
import { relativeUpdatedAt } from '../chat/session-labels';
import { sessionStatusLabel, truncateForDisplay } from './agent-format';

type AgentSessionItemsProps = {
  readonly sessions: readonly AgentSession[];
  readonly activeSessionId: string | null;
  readonly profileName: (profileId: string) => string;
  readonly onSelect: (sessionId: string) => void;
};

/**
 * The session history itself, shared by 6a's header chip and 6b's run-header
 * overflow so both states list runs identically. Prompts and model names are
 * provider-supplied strings and are rendered as text.
 *
 * With no runs yet the panel states that in words rather than opening onto an
 * empty box, so the control stays honest instead of appearing broken.
 */
export function AgentSessionItems({
  sessions,
  activeSessionId,
  profileName,
  onSelect,
}: AgentSessionItemsProps): ReactElement {
  if (sessions.length === 0) {
    return (
      <p data-testid="agent-session-list-empty" className="px-2 py-2 text-xs leading-[1.45] text-text-secondary">
        No agent sessions yet.
      </p>
    );
  }

  const now = new Date();
  return (
    <ul aria-label="All agent sessions" className="flex max-h-64 flex-col overflow-y-auto">
      {sessions.map((session) => (
        <li key={session.id}>
          <AgentSessionRow
            session={session}
            text={sessionRowText(session, now)}
            selected={activeSessionId === session.id}
            profileName={profileName(session.profileId)}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

type SessionRowText = {
  readonly title: string;
  readonly status: string;
  readonly age: string | null;
  readonly label: string;
};

/** The row's visible title, status and age, and the one-line name it is announced by. */
function sessionRowText(session: AgentSession, now: Date): SessionRowText {
  const prompt = session.userPrompt.trim();
  const title = prompt === '' ? 'Untitled task' : truncateForDisplay(prompt, 120);
  const status = sessionStatusLabel(session.status);
  const age = relativeUpdatedAt(session.updatedAt, now)?.toLowerCase() ?? null;
  const name = `Task: ${truncateForDisplay(title, 80).replace(/[.!?]+$/u, '')}`;
  const label = [name, status, ...(age === null ? [] : [age])].join(', ');
  return { title, status, age, label };
}

type AgentSessionRowProps = {
  readonly session: AgentSession;
  readonly text: SessionRowText;
  readonly selected: boolean;
  readonly profileName: string;
  readonly onSelect: (sessionId: string) => void;
};

/**
 * A menu row with a second line, like every other menu: the current run
 * carries the shared check rather than its own box, and the name reads as the
 * task, never the internal run id.
 */
function AgentSessionRow({ session, text, selected, profileName, onSelect }: AgentSessionRowProps): ReactElement {
  return (
    <button
      type="button"
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      aria-label={text.label}
      onClick={() => { onSelect(session.id); }}
      className={MENU_ITEM_TWO_LINE_CLASS}
    >
      <span aria-hidden="true" className={`${MENU_CHECK_SLOT_CLASS} mt-1`} data-testid="agent-session-item-check">
        {selected && <AppIcon name="check" size={12} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex w-full items-baseline justify-between gap-2">
          <span className="line-clamp-2 min-w-0 break-words">{text.title}</span>
          <span className="shrink-0 text-xs text-text-secondary">{text.status}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-text-secondary">
          <span className="break-words" data-testid="agent-session-item-profile">{profileName}</span>
          <span aria-hidden="true">·</span>
          <span className="break-all" data-testid="agent-session-item-model">
            {session.effectiveModel ?? 'Provider default'}
          </span>
          <SessionAge age={text.age} />
        </span>
      </span>
    </button>
  );
}

function SessionAge({ age }: { readonly age: string | null }): ReactElement | null {
  if (age === null) return null;
  return (
    <>
      <span aria-hidden="true">·</span>
      <span data-testid="agent-session-item-age">{age}</span>
    </>
  );
}

/** Popover box shared by both anchors: the shared menu surface, opening from the trigger's corner. */
export const SESSION_PANEL_CLASS = `${MENU_SURFACE_CLASS} fixed z-30 w-[280px] max-w-[calc(100vw-16px)]`;
