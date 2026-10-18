import type { UpdateState } from '@shared/schemas/updates';

/** The state main reports for an unpackaged run: the feed is never contacted. */
export const DEVELOPMENT_UPDATE_STATE: UpdateState = {
  currentVersion: '0.5.0',
  channel: 'stable',
  support: 'development',
  automaticChecks: true,
  lastCheckedAt: null,
  phase: { status: 'idle' },
};
