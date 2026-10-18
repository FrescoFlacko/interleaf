import type { ReactElement } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { Badge, BadgeDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { CardLabel } from '../../components/ui/card';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import type { OnboardingCapabilityStatus, OnboardingProviderRow } from './onboarding-rows';
import {
  groupOnboardingRows,
  primaryRowAction,
  rowReason,
  type OnboardingGroup,
  type OnboardingGroupKey,
} from './onboarding-groups';
import { ROW_ACTION_LABELS, useRowAction } from './row-actions';

/**
 * Step 2 — detection as a grouped list.
 *
 * One row per provider, not one card per capability: a row carries only what
 * changes a decision — the name, the version, the single action that would
 * unblock it, and which of the two modes it is ready for. The sentence that
 * explains a *state* is written once at the group, so a quiet list of ready
 * tools stays quiet.
 *
 * Copy is deliberately specific about what leaves the machine. Interleaf checks
 * which CLIs are installed and asks a configured local server for its model
 * list; neither is inference, and neither is described as "offline" beyond what
 * is actually true (§7).
 */

/**
 * Pill colour by capability state.
 *
 * `checking` is drawn as an outline rather than as a tone, because a pending
 * probe is not a weak success — it is not a result at all.
 */
function pillTone(status: OnboardingCapabilityStatus): 'success' | 'warning' | 'outline' {
  if (status.state === 'checking') return 'outline';
  if (status.tone === 'ready') return 'success';
  return status.tone === 'attention' ? 'warning' : 'outline';
}

/**
 * A mode readout.
 *
 * The visible text is the mode; the state rides along as text for a screen
 * reader, so "Chat" is never announced as if it were a success on its own.
 */
function CapabilityPill({ status }: { readonly status: OnboardingCapabilityStatus }): ReactElement {
  const tone = pillTone(status);
  return (
    <Badge
      tone={tone}
      size="pill"
      data-state={status.state}
      data-testid={`onboarding-pill-${status.capability}`}
      className={tone === 'outline' ? 'text-text-secondary' : undefined}
    >
      <BadgeDot className={tone === 'outline' ? 'opacity-50' : undefined} />
      {status.capability === 'chat' ? 'Chat' : 'Agent'}
      <span className="sr-only">: {status.label}</span>
    </Badge>
  );
}

function ProviderListRow({
  row,
  groupKey,
}: {
  readonly row: OnboardingProviderRow;
  readonly groupKey: OnboardingGroupKey;
}): ReactElement {
  const handle = useRowAction();
  const action = primaryRowAction(row);
  const reason = rowReason(row, groupKey);
  return (
    <li
      data-testid={`onboarding-row-${row.id}`}
      data-tone={row.tone}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-subtle px-3.5 py-3 first:border-t-0"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={
            groupKey === 'unavailable'
              ? 'text-sm font-medium text-text-secondary'
              : 'text-sm font-medium text-text-primary'
          }
        >
          {row.name}
        </span>
        {row.version !== null && (
          <span className="font-mono text-2xs text-text-secondary">{row.version}</span>
        )}
        {reason !== null && <span className="text-2xs text-text-secondary">{reason}</span>}
      </div>
      {action !== null && (
        <Button
          variant="link"
          size="inline"
          data-testid={`onboarding-action-${action}`}
          onClick={() => { handle(row, action); }}
        >
          {ROW_ACTION_LABELS[action]}
          <span className="sr-only"> for {row.name}</span>
        </Button>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {row.chat !== null && <CapabilityPill status={row.chat} />}
        {row.agent !== null && <CapabilityPill status={row.agent} />}
      </div>
    </li>
  );
}

function RowGroup({ group }: { readonly group: OnboardingGroup }): ReactElement {
  return (
    <section
      className="flex flex-col gap-2"
      data-testid={`onboarding-group-${group.key}`}
      data-count={group.rows.length}
      aria-label={`${group.label}: ${String(group.rows.length)}`}
    >
      <div className="flex items-baseline gap-2 px-0.5">
        <CardLabel>{group.label}</CardLabel>
        <span className="font-mono text-2xs text-text-secondary" data-testid={`onboarding-group-${group.key}-count`}>
          {group.rows.length}
        </span>
      </div>
      {group.description !== null && (
        <p className="px-0.5 text-xs leading-[1.55] text-pretty text-text-secondary">{group.description}</p>
      )}
      <ul className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        {group.rows.map((row) => (
          <ProviderListRow key={row.id} row={row} groupKey={group.key} />
        ))}
      </ul>
    </section>
  );
}

export function DiscoverStage({ rows }: { readonly rows: readonly OnboardingProviderRow[] }): ReactElement {
  const refreshDiscovery = useOnboardingStore((state) => state.refreshDiscovery);
  const groups = groupOnboardingRows(rows);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-xs leading-[1.6] text-pretty text-text-secondary">
          Checking which supported AI tools are already installed. Interleaf looks in the usual install
          locations for the CLIs it supports and, if you have configured one, asks your local server for
          its model list. It does not scan your network or your disk, and it does not run any model.
        </p>
        <p className="text-xs leading-[1.6] text-pretty text-text-secondary">
          A local server is a loopback connection to software you are running — not on-device inference
          by Interleaf.
        </p>
      </div>

      <div className="flex flex-col gap-4" data-testid="onboarding-rows">
        {groups.map((group) => (
          <RowGroup key={group.key} group={group} />
        ))}
      </div>

      <div className="flex">
        <Button
          variant="ghost"
          size="sm"
          data-testid="onboarding-recheck"
          onClick={() => { void refreshDiscovery(); }}
        >
          <AppIcon name="retry" size={13} /> Check again
        </Button>
      </div>
    </div>
  );
}
