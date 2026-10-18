import { useState, type ReactElement } from 'react';
import type { AgentProfile } from '@shared/types/agent';
import { bridge } from '../../app/api-client';

/**
 * Re-asks main to probe the installed CLIs for the models they accept.
 *
 * Discovery already runs automatically behind startup, so this exists only for
 * the case where a CLI was installed or upgraded while the app was open. Main
 * owns the probe entirely: this button carries no arguments, and the renderer
 * receives nothing but the refreshed profile projections it already had.
 */
export function AgentModelRefreshButton({ onRefreshed }: {
  readonly onRefreshed: (profiles: readonly AgentProfile[]) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const refresh = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      onRefreshed(await bridge.agent.refreshModels());
    } catch {
      // A failed listing changes nothing: the previous options stay selectable
      // and the CLI keeps its own default, so there is nothing to report here.
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      data-testid="refresh-agent-models"
      onClick={() => { void refresh(); }}
      disabled={busy}
      aria-busy={busy}
      className="settings-inline-action self-start"
    >
      {busy ? 'Checking installed agents…' : 'Check all installed agents for new models'}
    </button>
  );
}
