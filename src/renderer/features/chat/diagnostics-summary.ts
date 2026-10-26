import { AI_PROVIDER_DISPLAY_NAMES } from '@shared/constants/ai';
import type { DiagnosticsPacket, DiagnosticsProvider, DiagnosticsSignalCode } from '@shared/schemas/diagnostics';

/**
 * Plain-language readings of the packet main collected. Every line restates a
 * packet field; nothing here infers a cause, a score or that something works.
 */

const SIGNAL_LABELS: Readonly<Record<DiagnosticsSignalCode, string>> = {
  'import-failed': 'File import failed',
  'web-import-failed': 'Web page import failed',
  'update-download-failed': 'Update download failed',
  'update-stage-failed': 'Update preparation failed',
  'update-install-failed': 'Update install failed',
  'provider-process-start-failed': 'AI provider did not start',
  'provider-capability-probe-failed': 'AI provider capability check failed',
  'provider-auth-probe-failed': 'AI provider sign-in check failed',
  'provider-sign-in-incomplete': 'AI provider sign-in was not completed',
  'chat-model-listing-failed': 'Chat models could not be listed',
  'agent-model-discovery-failed': 'Agent models could not be listed',
  'agent-startup-persistence-failed': 'Agent session could not be saved at start',
  'startup-fatal': 'Interleaf could not start',
  'settings-reset-to-defaults': 'Settings were reset to defaults',
  'ipc-sender-rejected': 'An untrusted internal request was blocked',
  'ipc-handler-failed': 'An internal request failed',
  'conversation-naming-failed': 'A conversation could not be named',
  'diagram-render-failed': 'A diagram could not be drawn',
};

const OS_NAMES: Readonly<Record<DiagnosticsPacket['os']['family'], string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  other: 'Another system',
};

const AUTHENTICATION_LABELS: Readonly<Record<DiagnosticsProvider['authentication'], string>> = {
  connected: 'connected',
  disconnected: 'not connected',
  unknown: 'connection unknown',
  error: 'connection check failed',
};

export type SummaryLine = { readonly key: string; readonly label: string; readonly detail: string };

export type PacketSummary = {
  readonly app: string;
  readonly system: string;
  readonly providers: readonly SummaryLine[];
  readonly signals: readonly SummaryLine[];
  /** A neutral sentence about the log when there is nothing to count, or only part of it was read. */
  readonly logNote: string | null;
};

function times(count: number): string {
  return count === 1 ? '1 time' : `${count.toLocaleString('en-US')} times`;
}

function providerState(provider: DiagnosticsProvider): string {
  if (!provider.installed) return 'not installed';
  const state = AUTHENTICATION_LABELS[provider.authentication];
  return provider.available ? state : `${state}, unavailable`;
}

/** A partial scan says how many records it read and that the rest went unchecked; it never claims which records those were. */
function logNote(logs: DiagnosticsPacket['logs']): string | null {
  if (!logs.available) return 'The local log could not be read, so no problems are counted.';
  const found = logs.signals.length > 0;
  if (logs.truncated) {
    const scanned = `${logs.scannedRecords.toLocaleString('en-US')} log records`;
    return found
      ? `Counted from ${scanned} only. The rest of the local log was not checked.`
      : `No known problems were found in the ${scanned} read. The rest of the local log was not checked.`;
  }
  return found ? null : 'No known problems are recorded in the local log.';
}

export function summarizePacket(packet: DiagnosticsPacket): PacketSummary {
  const packaging = packet.app.packaging === 'packaged' ? 'installed app' : 'development build';
  return {
    app: `${packet.app.version} (${packaging})`,
    system: `${OS_NAMES[packet.os.family]}, ${packet.os.arch}`,
    providers: packet.providers.map((provider) => ({
      key: provider.id,
      label: AI_PROVIDER_DISPLAY_NAMES[provider.id],
      detail: providerState(provider),
    })),
    signals: packet.logs.available
      ? packet.logs.signals.map((signal) => ({ key: signal.code, label: SIGNAL_LABELS[signal.code], detail: times(signal.count) }))
      : [],
    logNote: logNote(packet.logs),
  };
}

const NOT_REQUESTED = '(Not requested.)\n';

/**
 * The text an analysis added to the reviewed report, found by comparing the
 * two reports main returned rather than by reading headings in either, so a
 * description that imitates a heading cannot move the boundary. Returns null
 * when the reports do not line up; the full report is still shown.
 */
export function addedAnalysis(reviewedText: string, analyzedText: string): string | null {
  if (!reviewedText.endsWith(NOT_REQUESTED)) return null;
  const shared = reviewedText.slice(0, -NOT_REQUESTED.length);
  if (!analyzedText.startsWith(shared)) return null;
  const added = analyzedText.slice(shared.length).trim();
  return added.length === 0 ? null : added;
}
