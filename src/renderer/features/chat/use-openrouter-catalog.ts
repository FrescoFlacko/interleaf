import { useCallback, useRef, useState } from 'react';
import type { AIModelInfo } from '@shared/types/ai';
import { bridge } from '../../app/api-client';

export type OpenRouterCatalogState = 'idle' | 'loading' | 'ready' | 'error';

export type OpenRouterCatalog = {
  readonly models: readonly AIModelInfo[];
  readonly state: OpenRouterCatalogState;
  readonly error: string | null;
  /** Loads the catalog; `forceRefresh` bypasses main's cached copy. Never rejects. */
  readonly fetch: (forceRefresh?: boolean) => Promise<void>;
};

/**
 * Owns model discovery for the OpenRouter row.
 *
 * Requests are numbered so a slow answer to an earlier load or retry never
 * replaces the newest one.
 */
export function useOpenRouterCatalog(): OpenRouterCatalog {
  const [models, setModels] = useState<readonly AIModelInfo[]>([]);
  const [state, setState] = useState<OpenRouterCatalogState>('idle');
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const fetch = useCallback(async (forceRefresh = false): Promise<void> => {
    const requestId = ++requestRef.current;
    setState('loading');
    setError(null);
    try {
      const listed = await bridge.ai.listOpenRouterModels(forceRefresh ? { forceRefresh: true } : undefined);
      if (requestId !== requestRef.current) return;
      setModels(listed);
      setState('ready');
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setState('error');
      setError(err instanceof Error ? err.message : 'Could not load OpenRouter model catalog.');
    }
  }, []);

  return { models, state, error, fetch };
}
