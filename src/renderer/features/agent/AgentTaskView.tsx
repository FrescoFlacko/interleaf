import type { ReactElement } from 'react';
import type { AgentExecutionMode } from '@shared/constants/agent-modes';
import type { DocumentMetadata } from '@shared/types/document';
import { useAgentStore } from '../../stores/use-agent-store';
import { useUiStore } from '../../stores/use-ui-store';
import { ScrollArea } from '../../components/ui/scroll-area';
import { AgentRunSettings } from './AgentRunSettings';
import { AgentSessionList } from './AgentSessionList';
import { AgentStartBar, startBusyReason } from './AgentStartBar';
import { agentProfileView } from './agent-profile-view';
import { AgentTaskCard } from './AgentTaskCard';

type AgentTaskViewProps = {
  readonly activeDocument: DocumentMetadata | null;
  readonly onModeChange: (mode: AgentExecutionMode) => void;
  readonly onModelChange: (model: string | null) => void;
};

/**
 * Reference 6a. The panel is a fixed header, one scrolling body and a pinned
 * action bar: the task card leads, every run setting is one card below it, and
 * session history is a header chip so it never competes for vertical space.
 */
export function AgentTaskView({ activeDocument, onModeChange, onModelChange }: AgentTaskViewProps): ReactElement {
  const executionMode = useUiStore((state) => state.composer.executionMode);
  const taskDraft = useUiStore((state) => state.composer.taskDraft);
  const profiles = useAgentStore((state) => state.profiles);
  const selectedProfileId = useAgentStore((state) => state.selectedProfileId);
  const modeAvailability = useAgentStore((state) => state.modeAvailability);
  const workingDirectory = useAgentStore((state) => state.workingDirectory);
  const sessions = useAgentStore((state) => state.sessions);
  const loading = useAgentStore((state) => state.loading);
  const launching = useAgentStore((state) => state.launching);
  // Start waits for any load, and for a launch already in flight.
  const startBusy = useAgentStore((state) => state.launching || state.loading);
  const hydrated = useAgentStore((state) => state.hydrated);
  const pendingContextLabel = useAgentStore((state) => state.pendingContext?.label ?? null);
  const error = useAgentStore((state) => state.error);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  // The task and its settings lock while a run is being launched, and until
  // the panel has loaded once. A later refresh keeps them usable — it already
  // keeps any choice made while it is in flight — so an open profile or model
  // menu stays open instead of closing under the reader. Start stays blocked
  // through either, below.
  const settingsLocked = launching || (loading && !hydrated);

  return (
    <section aria-labelledby="agent-composer-heading" className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-4 pt-3 pb-3">
        <div className="mr-auto flex min-w-0 flex-col gap-1">
          <h2 id="agent-composer-heading" className="text-base leading-[1.2] font-semibold tracking-[-0.012em] text-text-primary">
            New agent task
          </h2>
          <p className="text-xs leading-[1.35] text-text-secondary">
            Runs a coding agent against a folder on this machine
          </p>
        </div>
        <AgentSessionList
          sessions={sessions}
          activeSessionId={null}
          profileName={(profileId) => profiles.find((profile) => profile.id === profileId)?.name ?? profileId}
          onSelect={(sessionId) => { void useAgentStore.getState().selectSession(sessionId); }}
        />
      </div>

      <ScrollArea className="flex flex-col gap-3.5 px-4 pt-4 pb-4">
        <AgentTaskCard activeDocument={activeDocument} disabled={settingsLocked} />
        <AgentRunSettings disabled={settingsLocked} onModeChange={onModeChange} onModelChange={onModelChange} />
      </ScrollArea>

      <AgentStartBar
        activeDocument={activeDocument}
        profileView={agentProfileView(profiles, selectedProfileId)}
        workingDirectory={workingDirectory}
        executionMode={executionMode}
        modeAvailability={modeAvailability}
        taskDraft={taskDraft}
        busyReason={startBusyReason(startBusy, pendingContextLabel)}
        error={error}
        onStart={() => {
          if (selectedProfile === undefined || activeDocument === null) return;
          void startTask(selectedProfile.id, executionMode, taskDraft);
        }}
      />
    </section>
  );
}

/**
 * Once the run has started, its task lives in the run record and prompt
 * history, so the field is cleared: left filled, it stayed "ready to start"
 * and followed the reader to the next book. A task typed while the run was
 * starting, or one that failed to start, is kept.
 */
async function startTask(profileId: string, executionMode: AgentExecutionMode, prompt: string): Promise<void> {
  const started = await useAgentStore.getState().start(profileId, executionMode, prompt);
  const ui = useUiStore.getState();
  if (started && ui.composer.taskDraft === prompt) ui.setTaskDraft('');
}
