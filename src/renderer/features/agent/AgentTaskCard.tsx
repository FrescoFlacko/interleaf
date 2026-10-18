import type { ReactElement } from 'react';
import type { DocumentMetadata } from '@shared/types/document';
import { useUiStore } from '../../stores/use-ui-store';
import { useAgentStore } from '../../stores/use-agent-store';
import { promptHistoryScope } from '../../hooks/prompt-history';
import { usePromptHistory } from '../../hooks/use-prompt-history';
import { CardFooter, CardLabel } from '../../components/ui/card';
import { ComposerShell } from '../../components/companion/ComposerShell';
import { Textarea } from '../../components/ui/textarea';
import { AgentContextControls } from './AgentContextControls';

type AgentTaskCardProps = {
  readonly activeDocument: DocumentMetadata | null;
  readonly disabled: boolean;
};

/**
 * The 6a leading card: the task is the first thing on the panel, and the
 * document-context controls live in the card's own footer rather than in a
 * separate section, so attaching context reads as part of writing the task.
 */
export function AgentTaskCard({ activeDocument, disabled }: AgentTaskCardProps): ReactElement {
  const taskDraft = useUiStore((state) => state.composer.taskDraft);
  const setTaskDraft = useUiStore((state) => state.setTaskDraft);
  // The tasks this reader has already started, oldest first. The session list
  // is the record of what was submitted, so ArrowUp walks back through real
  // past tasks rather than through a separate list this panel would have to
  // keep in step with them.
  const sessions = useAgentStore((state) => state.sessions);
  const documentScope = promptHistoryScope(activeDocument);
  const promptHistory = usePromptHistory({
    submitted: [...sessions].reverse().map((session) => session.userPrompt),
    onValueChange: setTaskDraft,
    resetKey: documentScope,
  });

  return (
    <ComposerShell padding="none" className="agent-task-card" data-testid="agent-context-section">
      <div className="px-3 pt-3 pb-1">
        {/* Decorative: the field carries its own accessible name. */}
        <CardLabel aria-hidden="true">Task</CardLabel>
      </div>
      <div className="px-3 pt-1 pb-3">
        <Textarea
          id="agent-task-description"
          data-testid="agent-task-description"
          aria-label="Task description"
          rows={3}
          disabled={disabled || activeDocument === null}
          value={taskDraft}
          onChange={(event) => { setTaskDraft(event.target.value); }}
          onKeyDown={promptHistory.handleKeyDown}
          placeholder={activeDocument === null
            ? 'Open a document to enable the agent composer…'
            : 'Describe what the agent should do…'}
          className="companion-readable min-h-20 field-sizing-content"
        />
      </div>
      <CardFooter>
        {/* Keyed by book so an open page picker and its typed range never carry over. */}
        <AgentContextControls key={documentScope} activeDocument={activeDocument} />
      </CardFooter>
    </ComposerShell>
  );
}
