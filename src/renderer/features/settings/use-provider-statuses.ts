import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIProviderStatus } from '@shared/types/ai';
import { bridge } from '../../app/api-client';
import {
  getLatestProviderStatuses,
  getProviderStatusRevision,
  publishProviderStatus,
  publishProviderStatuses,
  subscribeProviderStatuses,
} from '../../stores/provider-status-freshness';

/** A started provider-list probe, identified so a superseded one is ignored. */
type ProviderListProbe = {
  readonly requestId: number;
  /** The freshness revision when the probe started, to detect newer statuses. */
  readonly freshnessRevision: number;
  readonly settled: Promise<{ readonly ok: true; readonly list: readonly AIProviderStatus[] }
    | { readonly ok: false; readonly reason: Error | null }>;
};

/** What adopting a probe produced: nothing to do, or a failure to report. */
type ProviderListOutcome = { readonly failed: false } | { readonly failed: true; readonly message: string };

export type ProviderStatuses = {
  readonly providers: readonly AIProviderStatus[];
  /**
   * Whether the live provider probe has answered yet.
   *
   * Tracked apart from the dialog's own readiness so the dialog can be usable
   * before the probe finishes without any row claiming a status nobody has
   * checked.
   */
  readonly ready: boolean;
  /** Starts a provider-list probe; its rejection is claimed at once. */
  readonly probe: () => ProviderListProbe;
  /** Adopts a probe's answer unless a newer probe or user action replaced it. */
  readonly adoptProbe: (probe: ProviderListProbe) => Promise<ProviderListOutcome>;
  /**
   * Marks every probe in flight as stale and returns the token a user action
   * checks before adopting its own result.
   */
  readonly supersede: () => number;
  readonly isCurrent: (requestId: number) => boolean;
  /** Replaces one provider's status here and for every other consumer. */
  readonly adoptStatus: (status: AIProviderStatus) => void;
};

/** Replaces one provider's row, appending it when the list did not carry it. */
function mergeProviderStatus(
  current: readonly AIProviderStatus[],
  status: AIProviderStatus
): readonly AIProviderStatus[] {
  const updated = current.map((provider) => (provider.id === status.id ? status : provider));
  return updated.some((provider) => provider.id === status.id) ? updated : [...updated, status];
}

async function settleProviderList(): Promise<Awaited<ProviderListProbe['settled']>> {
  try {
    // Opening Settings is the reader asking what is installed and signed in
    // now, so it probes again rather than reading main's cached readiness.
    return { ok: true, list: await bridge.ai.listProviders({ forceRefresh: true }) };
  } catch (reason) {
    return { ok: false, reason: reason instanceof Error ? reason : null };
  }
}

/**
 * Owns the provider statuses the settings rows describe.
 *
 * The list follows the app-wide freshness snapshot, so a status another surface
 * published — a sign-in finished by an earlier dialog, for example — replaces
 * the one this dialog last probed.
 */
export function useProviderStatuses(): ProviderStatuses {
  const [providers, setProviders] = useState<readonly AIProviderStatus[]>([]);
  const [ready, setReady] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => subscribeProviderStatuses((statuses) => { setProviders(statuses); }), []);

  const probe = useCallback((): ProviderListProbe => {
    setReady(false);
    return {
      requestId: ++requestRef.current,
      freshnessRevision: getProviderStatusRevision(),
      settled: settleProviderList(),
    };
  }, []);

  const adoptProbe = useCallback(async (started: ProviderListProbe): Promise<ProviderListOutcome> => {
    const result = await started.settled;
    if (started.requestId !== requestRef.current) return { failed: false };
    if (!result.ok) {
      // Without status there is nothing truthful to say about any provider, so
      // a failed probe is reported as a retryable load error.
      return { failed: true, message: result.reason !== null ? result.reason.message : 'Failed to check AI providers.' };
    }
    const freshnessChanged = started.freshnessRevision !== getProviderStatusRevision();
    setProviders(freshnessChanged ? (getLatestProviderStatuses() ?? result.list) : result.list);
    if (!freshnessChanged) publishProviderStatuses(result.list);
    setReady(true);
    return { failed: false };
  }, []);

  const supersede = useCallback((): number => ++requestRef.current, []);
  const isCurrent = useCallback((requestId: number): boolean => requestId === requestRef.current, []);

  const adoptStatus = useCallback((status: AIProviderStatus): void => {
    setProviders((current) => mergeProviderStatus(current, status));
    publishProviderStatus(status);
  }, []);

  return { providers, ready, probe, adoptProbe, supersede, isCurrent, adoptStatus };
}
