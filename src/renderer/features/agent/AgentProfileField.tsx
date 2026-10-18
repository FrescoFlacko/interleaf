import type { ReactElement } from 'react';
import type { AgentProfile } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { useUiStore } from '../../stores/use-ui-store';
import { Badge, BadgeDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/select';
import { agentProfileOptions, isInstalled, staleProfile } from './agent-run-options';

const CAPTION = 'text-xs text-text-secondary';

function profileCaption(profile: AgentProfile | undefined): string {
  if (profile === undefined) return 'No agent profile selected.';
  if (!isInstalled(profile)) return `${profile.detection.errorMessage ?? 'Executable not found'}. Choose an installed agent to run.`;
  return profile.capabilities.nativeSandbox ? 'Installed · sandbox capable' : 'Installed · isolated sandbox default';
}

function useProfileState() {
  const profiles = useAgentStore((state) => state.profiles);
  const selectedProfileId = useAgentStore((state) => state.selectedProfileId);
  return {
    selectedProfileId,
    selectedProfile: profiles.find((profile) => profile.id === selectedProfileId),
    stale: staleProfile(profiles, selectedProfileId),
    options: agentProfileOptions(profiles),
  };
}

/**
 * The Run settings agent picker chip. It offers installed agents only; a
 * stored agent that has since gone missing stays on the trigger and is
 * flagged by `AgentProfileNotes`, never silently swapped for another. It is
 * only shown while something is installed: otherwise `AgentRuntimeEmptyState`
 * takes the whole card.
 */
export function AgentProfilePicker({ disabled }: { readonly disabled: boolean }): ReactElement {
  const { selectedProfileId, stale, options } = useProfileState();
  return (
    <Select
      id="agent-profile"
      variant="chip"
      title="Agent"
      aria-label="Agent profile"
      aria-describedby="agent-profile-help"
      aria-invalid={stale !== null}
      data-testid="agent-profile-select"
      disabled={disabled}
      value={selectedProfileId ?? ''}
      placeholder={stale?.name ?? 'Choose an agent'}
      options={options}
      onValueChange={(id) => { useAgentStore.getState().setSelectedProfile(id); }}
    />
  );
}

/** The agent picker's status badge, caption and settings link, below the row. */
export function AgentProfileNotes(): ReactElement {
  const openSettings = useUiStore((state) => state.openSettings);
  const { selectedProfile, stale } = useProfileState();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {stale !== null && <StaleBadge profile={stale} />}
      {/* A floor on the caption's width: beside the badge and the link it
          wraps onto its own line rather than shrinking to one word per line. */}
      <p id="agent-profile-help" className={`${CAPTION} min-w-48 flex-1`} data-testid="agent-profile-caption">
        {profileCaption(selectedProfile)}
      </p>
      <Button
        size="inline"
        variant="link"
        data-testid="agent-open-custom-profile-settings"
        onClick={() => { openSettings('custom-profiles'); }}
      >
        Custom profiles…
      </Button>
    </div>
  );
}

function StaleBadge({ profile }: { readonly profile: AgentProfile }): ReactElement {
  return (
    <Badge tone="warning" data-testid="agent-profile-unavailable">
      <BadgeDot />
      {profile.detection.availability === 'error' ? 'Unavailable' : 'Not installed'}
    </Badge>
  );
}

/**
 * The Run settings card when no agent can run at all: one heading, one
 * sentence and one way forward, instead of pickers with nothing to offer.
 * Agents are detected when Interleaf starts, so that is what the guidance
 * says. A saved choice that went missing is still named, never dropped.
 */
export function AgentRuntimeEmptyState({ stale }: { readonly stale: AgentProfile | null }): ReactElement {
  const openSettings = useUiStore((state) => state.openSettings);
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-4" data-testid="agent-profile-empty">
      <h3 className="text-sm font-semibold text-text-primary">No agent runtime installed</h3>
      <p id="agent-profile-help" className={CAPTION} data-testid="agent-profile-caption">
        Install a coding agent such as Codex or Claude Code, then restart Interleaf so it can find it.
      </p>
      {stale !== null && (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="agent-profile-saved-choice">
          <StaleBadge profile={stale} />
          <span className={CAPTION}>Your saved agent, {stale.name}, was not found.</span>
        </div>
      )}
      <Button
        className="mt-1"
        variant="primary"
        data-testid="agent-open-provider-settings"
        onClick={() => { openSettings('ai'); }}
      >
        Open AI Providers
      </Button>
    </div>
  );
}
