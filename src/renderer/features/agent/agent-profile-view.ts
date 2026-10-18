import type { AgentProfile } from '@shared/types/agent';
import { isInstalled } from './agent-run-options';

/**
 * What the new-task view can say about the agent it would run.
 *
 * The store only ever selects an uninstalled profile because the user chose it
 * (a stored default, or a pick that has since been uninstalled), so a selected
 * profile that cannot run is a real stale choice: it stays named and flagged,
 * never swapped for another. `none-installed` keeps that choice too, so the
 * empty state can still say which saved agent went missing.
 */
export type AgentProfileView =
  | { readonly kind: 'none-installed'; readonly stale: AgentProfile | null }
  | { readonly kind: 'unselected' }
  | { readonly kind: 'stale'; readonly profile: AgentProfile }
  | { readonly kind: 'ready'; readonly profile: AgentProfile };

export function agentProfileView(profiles: readonly AgentProfile[], selectedId: string | null): AgentProfileView {
  const selected = profiles.find((profile) => profile.id === selectedId);
  const stale = selected !== undefined && !isInstalled(selected) ? selected : null;
  if (!profiles.some(isInstalled)) return { kind: 'none-installed', stale };
  if (selected === undefined) return { kind: 'unselected' };
  return stale === null ? { kind: 'ready', profile: selected } : { kind: 'stale', profile: stale };
}

/** The start bar's reason when the agent itself is what blocks a run. */
export function profileBlockedReason(view: AgentProfileView): string | null {
  switch (view.kind) {
    case 'none-installed':
      return 'Install an agent runtime to start a task.';
    case 'unselected':
      return 'Choose an agent to start.';
    case 'stale':
      return `${view.profile.name} is not installed on this machine. Choose an installed agent to start.`;
    case 'ready':
      return null;
  }
}
