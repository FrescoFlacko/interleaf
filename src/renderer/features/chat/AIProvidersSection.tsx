import { useEffect, useState, type ReactElement } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { AddProviderButton, OpenRouterPanel, type OpenRouterPanelProps } from './OpenRouterPanel';
import { AgentProviderPanel, type AgentProviderPanelProps } from './AgentProviderPanel';
import { LocalProviderPanel, type LocalProviderPanelProps } from './LocalProviderPanel';
import { groupProviderRows, type ProviderRow } from './provider-rows';
import { SettingsSectionHeader } from './SettingsSectionHeader';

export type AIProvidersSectionProps = {
  readonly rows: readonly ProviderRow[];
  /** At most one provider is open at a time. */
  readonly expandedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly openRouter: OpenRouterPanelProps;
  readonly agent: Omit<AgentProviderPanelProps, 'row'>;
  readonly local: LocalProviderPanelProps;
  /** Present only while there is a provider left to add. */
  readonly onAddProvider: (() => void) | null;
};

type PanelContext = {
  readonly row: ProviderRow;
  readonly openRouter: OpenRouterPanelProps;
  readonly agent: Omit<AgentProviderPanelProps, 'row'>;
  readonly local: LocalProviderPanelProps;
};

/**
 * Which configuration panel each kind of provider row opens, and the extra body
 * class it needs.
 *
 * A table rather than a chain of conditions, so adding a provider kind is an
 * entry here and a compile error when one is forgotten, not another branch.
 */
const PROVIDER_PANELS: Readonly<Record<ProviderRow['kind'], {
  readonly bodyClass: string;
  readonly render: (context: PanelContext) => ReactElement;
}>> = {
  openrouter: { bodyClass: '', render: ({ openRouter }) => <OpenRouterPanel {...openRouter} /> },
  local: { bodyClass: '', render: ({ local }) => <LocalProviderPanel {...local} /> },
  agent: { bodyClass: ' provider-body--agent', render: ({ row, agent }) => <AgentProviderPanel row={row} {...agent} /> },
  'chat-cli': { bodyClass: '', render: ({ row, agent }) => <AgentProviderPanel row={row} {...agent} /> },
};

function ProviderSummary({ row, expanded, onToggle }: {
  readonly row: ProviderRow;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}): ReactElement {
  return (
    <button
      type="button"
      id={`provider-summary-${row.id}`}
      data-testid={`provider-summary-${row.id}`}
      className="provider-summary"
      aria-expanded={expanded}
      aria-controls={`provider-panel-${row.id}`}
      onClick={() => { onToggle(row.id); }}
    >
      <span className={`provider-dot provider-dot--${row.tone}`} />
      <span className="provider-identity">
        <span className="flex min-w-0 items-center gap-2">
          <span className="provider-name">{row.name}</span>
          {row.version !== null && <span className="provider-version truncate">{row.version}</span>}
        </span>
        {/* An open row states its description once, as its body lede (5a/5d). */}
        {!expanded && <span className="provider-description">{row.description}</span>}
      </span>
      <span className="provider-trailing">
        <span className="provider-status" data-testid={`provider-status-${row.id}`}>{row.statusLabel}</span>
        <AppIcon name={expanded ? 'disclosure-expanded' : 'disclosure-collapsed'} size={14} className="provider-chevron" />
      </span>
    </button>
  );
}

function ProviderList({ rows, expandedId, onToggle, panels }: {
  readonly rows: readonly ProviderRow[];
  readonly expandedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly panels: Omit<PanelContext, 'row'>;
}): ReactElement {
  return (
    <div className="provider-list">
      {rows.map((row) => {
        const expanded = expandedId === row.id;
        const panel = PROVIDER_PANELS[row.kind];
        return (
          <div key={row.id} className={`provider-row${expanded ? ' provider-row--expanded' : ''}`}>
            <ProviderSummary row={row} expanded={expanded} onToggle={onToggle} />
            {expanded && (
              <div
                id={`provider-panel-${row.id}`}
                data-testid={`provider-panel-${row.id}`}
                role="region"
                aria-labelledby={`provider-summary-${row.id}`}
                className={`provider-body${panel.bodyClass}`}
              >
                {panel.render({ row, ...panels })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The reader's own expand/collapse of the group, or null to follow its rows.
 * A row in the group newly opened (from a deep link) clears it, opening the
 * group again.
 */
function useGroupChoice(expandedId: string | null, childExpanded: boolean) {
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const [seenExpandedId, setSeenExpandedId] = useState(expandedId);
  if (seenExpandedId !== expandedId) {
    setSeenExpandedId(expandedId);
    if (childExpanded) setUserChoice(null);
  }
  return [userChoice, setUserChoice] as const;
}

/**
 * Integrations whose CLI is absent, gathered under one collapsed toggle. A deep
 * link to, or an open editor in, one of its rows opens the group, but the
 * reader's own collapse or expand of the group always wins; collapsing only
 * hides the rows, so an open editor keeps its drafts for the next expand.
 */
function NotInstalledGroup({ rows, expandedId, onToggle, panels }: {
  readonly rows: readonly ProviderRow[];
  readonly expandedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly panels: Omit<PanelContext, 'row'>;
}): ReactElement {
  const childExpanded = rows.some((row) => row.id === expandedId);
  const [userChoice, setUserChoice] = useGroupChoice(expandedId, childExpanded);
  const groupOpen = userChoice ?? childExpanded;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="provider-group-toggle"
        data-testid="provider-not-installed-toggle"
        aria-expanded={groupOpen}
        aria-controls="provider-not-installed-list"
        onClick={() => { setUserChoice(!groupOpen); }}
      >
        <AppIcon name={groupOpen ? 'disclosure-expanded' : 'disclosure-collapsed'} size={14} />
        Not installed ({String(rows.length)})
      </button>
      <div id="provider-not-installed-list" hidden={!groupOpen}>
        <ProviderList rows={rows} expandedId={expandedId} onToggle={onToggle} panels={panels} />
      </div>
    </div>
  );
}

function providerRowElement(id: string): HTMLElement | null {
  return document.getElementById(`provider-summary-${id}`)?.parentElement ?? null;
}

/** Scrolls a provider row into view; false while it has not rendered yet. */
function revealProviderRow(id: string): boolean {
  const row = providerRowElement(id);
  if (row === null) return false;
  if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  return true;
}

/**
 * The single bordered provider list from design 5a. Every summary is a real
 * button with `aria-expanded`/`aria-controls`, so the list is operable from the
 * keyboard, and each provider owns its configuration — including the agent
 * profile merged in from the former Agent Profiles page (5d). Integrations
 * whose CLI is absent sit in a collapsed "Not installed (n)" group below it.
 */
export function AIProvidersSection({ rows, expandedId, onToggle, openRouter, agent, local, onAddProvider }: AIProvidersSectionProps): ReactElement {
  const { present, notInstalled } = groupProviderRows(rows);
  const panels = { openRouter, agent, local };
  // A deep link may open a row far down the list: bring it into view once,
  // when its row first renders, rather than on every toggle.
  const [pendingReveal, setPendingReveal] = useState(expandedId);
  useEffect(() => {
    if (pendingReveal === null) return;
    if (revealProviderRow(pendingReveal)) setPendingReveal(null);
  }, [pendingReveal, rows]);
  return (
    <section aria-labelledby="settings-ai-providers-heading" className="min-w-0">
      <SettingsSectionHeader
        id="settings-ai-providers-heading"
        title="AI providers"
        description="Each provider holds its own connection, chat model and agent profile. Keys are stored in your OS keychain."
        action={onAddProvider === null ? undefined : <AddProviderButton onClick={onAddProvider} />}
      />
      <div className="flex min-w-0 flex-col gap-3">
        <ProviderList rows={present} expandedId={expandedId} onToggle={onToggle} panels={panels} />
        {notInstalled.length > 0 && (
          <NotInstalledGroup rows={notInstalled} expandedId={expandedId} onToggle={onToggle} panels={panels} />
        )}
      </div>
    </section>
  );
}
