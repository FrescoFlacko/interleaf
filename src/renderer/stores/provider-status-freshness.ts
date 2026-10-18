import type { AIProviderStatus } from '@shared/types/ai';

type ProviderStatusListener = (statuses: readonly AIProviderStatus[]) => void;

let latest: readonly AIProviderStatus[] | null = null;
let revision = 0;
const listeners = new Set<ProviderStatusListener>();

/**
 * Keeps provider completion freshness independent from a transient Settings
 * modal instance. The main process remains authoritative; this is only a
 * renderer snapshot used to notify a newly mounted surface.
 */
export function publishProviderStatuses(statuses: readonly AIProviderStatus[]): void {
  latest = statuses;
  revision += 1;
  for (const listener of listeners) listener(statuses);
}

export function publishProviderStatus(status: AIProviderStatus): void {
  const current = latest ?? [];
  const updated = current.map((provider) => provider.id === status.id ? status : provider);
  publishProviderStatuses(updated.some((provider) => provider.id === status.id) ? updated : [...updated, status]);
}

export function subscribeProviderStatuses(listener: ProviderStatusListener): () => void {
  listeners.add(listener);
  if (latest !== null) listener(latest);
  return () => { listeners.delete(listener); };
}

export function getProviderStatusRevision(): number {
  return revision;
}

export function getLatestProviderStatuses(): readonly AIProviderStatus[] | null {
  return latest;
}
