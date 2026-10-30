import { RETRYABLE_DOWNLOAD_ERRORS, type ActiveWorkSummary, type UpdatePhase, type UpdateState, type UpdateSupport } from '@shared/schemas/updates';

/**
 * Plain-language copy for the About & Updates panel. Every string is fixed or
 * built from validated fields (versions, counts, a timestamp); nothing from a
 * release, a remote server or an error message other than main's own fixed
 * text reaches the page.
 */

const SUPPORT_COPY: Readonly<Record<Exclude<UpdateSupport, 'self-update'>, string>> = {
  'package-manager':
    'This copy was installed by your system package manager, which owns its files. Update it the same way you installed it, or download a newer package from the release page.',
  development: 'This is a development build. It never checks the release server.',
  unsupported: 'This installation cannot update itself. Download newer releases from the release page.',
};

type PhaseCopy = { readonly [Status in UpdatePhase['status']]: (phase: Extract<UpdatePhase, { status: Status }>) => string };

const PHASE_COPY: PhaseCopy = {
  idle: () => 'Interleaf has not checked for updates yet.',
  checking: () => 'Checking for updates…',
  'up-to-date': () => 'Interleaf is up to date.',
  'no-release': () => 'No stable release has been published yet, so there is nothing to compare against.',
  available: (phase) => `Interleaf ${phase.version} is available.`,
  downloading: (phase) => `Downloading Interleaf ${phase.version}… ${String(Math.floor(phase.percent))}%`,
  downloaded: (phase) => `Interleaf ${phase.version} is ready. Restart when it suits you; nothing restarts on its own.`,
  installing: (phase) => `Preparing to restart into Interleaf ${phase.version}…`,
  error: (phase) => phase.message,
};

export function updateStatusText(state: UpdateState): string {
  if (state.support !== 'self-update') return SUPPORT_COPY[state.support];
  const { phase } = state;
  // The lookup is keyed by the phase's own status, so each entry receives its own shape.
  const describe = PHASE_COPY[phase.status] as (value: UpdatePhase) => string;
  return describe(phase);
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function activeWorkText(work: ActiveWorkSummary): string {
  const parts = [
    work.agentSessions > 0 ? plural(work.agentSessions, 'agent run') : null,
    work.chatStreams > 0 ? plural(work.chatStreams, 'chat reply') : null,
    work.imports > 0 ? plural(work.imports, 'import') : null,
  ].filter((part): part is string => part !== null);
  return `Restart is waiting for running work to finish: ${parts.join(', ')}. Nothing was interrupted.`;
}

export function lastCheckedText(lastCheckedAt: string | null, locale?: string): string | null {
  if (lastCheckedAt === null) return null;
  const formatted = new Date(lastCheckedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return `Last checked ${formatted}`;
}

/** Whether the user may ask for a check right now. */
export function canCheck(state: UpdateState): boolean {
  return state.support === 'self-update' && !['checking', 'downloading', 'downloaded', 'installing'].includes(state.phase.status);
}

/** The verified version a download button would fetch, if one is offered. */
export function downloadableVersion(phase: UpdatePhase): string | null {
  if (phase.status === 'available') return phase.version;
  if (phase.status === 'error' && RETRYABLE_DOWNLOAD_ERRORS.has(phase.code) && phase.version !== undefined) return phase.version;
  return null;
}
