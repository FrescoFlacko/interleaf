import { AI_PROVIDER_IDS } from '@shared/constants/ai';
import type { AIProviderStatus } from '@shared/types/ai';
import {
  DIAGNOSTICS_FORMAT,
  diagnosticsPacketSchema,
  type DiagnosticsPacket,
  type DiagnosticsProvider,
  type DiagnosticsSignalCode,
} from '@shared/schemas/diagnostics';
import type { LogCategory, LogLevel } from '../logging/logger';
import { resolveDiagnosticsAppVersion } from './build-identity';

export { resolveDiagnosticsAppVersion };

/**
 * Builds the allowlisted diagnostics packet.
 *
 * Every field is chosen, not filtered: versions, OS family and architecture,
 * the packaging state, per-provider readiness enums, and aggregate log counts.
 * Log records are read only to count them by category and level and to count
 * the fixed messages below by stable code; message text, metadata, times and
 * paths never enter the packet. Provider names, versions, error messages,
 * models and binary locations are left out, as are library, chat, document,
 * settings and credential data, which this module cannot reach.
 */

export type DiagnosticsEnvironment = {
  readonly appVersion: string;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
  readonly packaged: boolean;
  readonly platform: string;
  readonly arch: string;
};

/** This process's runtime: versions, OS family and architecture only. */
export function processEnvironment(appVersion: string, packaged: boolean): DiagnosticsEnvironment {
  const { electron, chrome, node } = process.versions;
  return {
    appVersion,
    versions: { electron, chrome, node },
    packaged,
    platform: process.platform,
    arch: process.arch,
  };
}

/** The one log reader the packet uses; implemented by the durable log sink. */
type DiagnosticsLogScanner = {
  scanRecords(
    visit: (category: LogCategory, level: LogLevel, message: string) => void,
    maxRecords: number,
  ): Promise<{ readonly scanned: number; readonly truncated: boolean }>;
};

export type PacketSources = {
  readonly environment: DiagnosticsEnvironment;
  readonly providerStatuses: () => Promise<readonly AIProviderStatus[]>;
  readonly logs: DiagnosticsLogScanner | null;
  readonly now: () => Date;
};

/** Retained logs are at most a few megabytes; this bounds the scan regardless. */
const MAX_SCANNED_RECORDS = 50_000;

/** Fixed warning and error messages, matched exactly, and the code each counts as. */
const SIGNAL_MESSAGES: ReadonlyMap<string, DiagnosticsSignalCode> = new Map([
  ['Failed to import document', 'import-failed'],
  ['Web article import failed before storage', 'web-import-failed'],
  ['Update download failed', 'update-download-failed'],
  ['Update could not be staged for installation', 'update-stage-failed'],
  ['Update install did not start; quitting', 'update-install-failed'],
  ['AI provider chat process could not start', 'provider-process-start-failed'],
  ['AI provider capability probe did not complete', 'provider-capability-probe-failed'],
  ['Codex auth status probe failed', 'provider-auth-probe-failed'],
  ['Claude auth status probe failed', 'provider-auth-probe-failed'],
  ['Pi auth check probe failed', 'provider-auth-probe-failed'],
  ['ChatGPT sign-in process did not complete', 'provider-sign-in-incomplete'],
  ['Reader Chat model listing probe failed', 'chat-model-listing-failed'],
  ['agent model discovery probe failed', 'agent-model-discovery-failed'],
  ['agent startup persistence failed', 'agent-startup-persistence-failed'],
  ['fatal startup failure', 'startup-fatal'],
  ['stored settings failed schema validation; using defaults', 'settings-reset-to-defaults'],
  ['Rejected message from unauthorized sender', 'ipc-sender-rejected'],
  ['IPC handler failed', 'ipc-handler-failed'],
  ['Conversation naming failed', 'conversation-naming-failed'],
  ['mermaid render failed inside the isolated renderer', 'diagram-render-failed'],
]);

export async function collectDiagnosticsPacket(sources: PacketSources): Promise<DiagnosticsPacket> {
  const { environment } = sources;
  const packet: DiagnosticsPacket = {
    format: DIAGNOSTICS_FORMAT,
    collectedAt: sources.now().toISOString(),
    app: {
      version: environment.appVersion,
      electron: environment.versions.electron,
      chrome: environment.versions.chrome,
      node: environment.versions.node,
      packaging: environment.packaged ? 'packaged' : 'development',
    },
    os: { family: osFamily(environment.platform), arch: osArch(environment.arch) },
    providers: providerReadiness(await sources.providerStatuses()),
    logs: await summarizeLogs(sources.logs),
  };
  // The schema is the allowlist: anything outside it fails collection.
  return diagnosticsPacketSchema.parse(packet);
}

export function serializePacket(packet: DiagnosticsPacket): string {
  return JSON.stringify(packet, null, 2);
}

function osFamily(platform: string): DiagnosticsPacket['os']['family'] {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other';
}

function osArch(arch: string): DiagnosticsPacket['os']['arch'] {
  return arch === 'arm64' || arch === 'x64' || arch === 'ia32' || arch === 'arm' ? arch : 'other';
}

function providerReadiness(statuses: readonly AIProviderStatus[]): DiagnosticsProvider[] {
  return AI_PROVIDER_IDS.flatMap((id) => {
    const status = statuses.find((entry) => entry.id === id);
    if (status === undefined) return [];
    return [{
      id,
      available: status.available,
      installed: status.installed,
      authentication: status.authentication,
      toolFreeMode: status.capabilities.toolFreeMode,
      hostedWebSearch: status.capabilities.hostedWebSearch,
    }];
  });
}

async function summarizeLogs(logs: DiagnosticsLogScanner | null): Promise<DiagnosticsPacket['logs']> {
  if (logs === null) return { available: false, scannedRecords: 0, truncated: false, counts: [], signals: [] };
  const counts = new Map<string, { category: LogCategory; level: LogLevel; count: number }>();
  const signals = new Map<DiagnosticsSignalCode, number>();
  let result: { readonly scanned: number; readonly truncated: boolean };
  try {
    result = await logs.scanRecords((category, level, message) => {
      const key = `${category}:${level}`;
      const entry = counts.get(key) ?? { category, level, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
      const code = level === 'warn' || level === 'error' ? SIGNAL_MESSAGES.get(message) : undefined;
      if (code !== undefined) signals.set(code, (signals.get(code) ?? 0) + 1);
    }, MAX_SCANNED_RECORDS);
  } catch {
    // An unreadable or unsafe log directory yields no log summary, not a failed collection.
    return { available: false, scannedRecords: 0, truncated: false, counts: [], signals: [] };
  }
  return {
    available: true,
    scannedRecords: result.scanned,
    truncated: result.truncated,
    counts: [...counts.values()].sort((left, right) => `${left.category}:${left.level}`.localeCompare(`${right.category}:${right.level}`)),
    signals: [...signals.entries()].map(([code, count]) => ({ code, count })).sort((left, right) => left.code.localeCompare(right.code)),
  };
}
