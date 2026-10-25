import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { AIModelInfo, AIProviderId, AIProviderStatus } from '@shared/types/ai';
import {
  DIAGNOSTICS_LIMITS,
  type DiagnosticsAnalyzeResult,
  type DiagnosticsCollectResult,
  type DiagnosticsExportResult,
  type DiagnosticsFailure,
  type DiagnosticsPacket,
  type DiagnosticsPreviewResult,
  type DiagnosticsProviderChoice,
  type DiagnosticsProviderId,
} from '@shared/schemas/diagnostics';
import { AI_PROVIDER_IDS } from '@shared/constants/ai';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { AIProvider, ProviderChatRequest } from '../ai/providers/types';
import type { Logger } from '../logging/logger';
import { collectDiagnosticsPacket, serializePacket, type PacketSources } from './packet';
import { buildAnalysisMessage, buildReport, DIAGNOSTICS_SYSTEM_PROMPT, sanitizeAnalysis, type ReportAnalysis } from './report';
import { sanitizeFreeText } from './sanitize';

/**
 * Main-owned private diagnostics.
 *
 * Collection builds one allowlisted packet and returns an opaque handle bound
 * to it and to the window that asked. Preview fixes the sanitized issue text
 * and the exact report; analysis sends that reviewed packet and text to one
 * tool-free provider the user chose, re-checked here, and replaces the report
 * with one that includes the sanitized answer; export writes the current
 * report through a native save dialog. A handle is usable only by its owner,
 * expires, and is dropped with its window, on dismissal and at shutdown; an
 * answer that arrives after its handle moved on is discarded.
 */

type DiagnosticsProviderRegistry = {
  listStatuses(): Promise<readonly AIProviderStatus[]>;
  getStatus(providerId: AIProviderId): Promise<AIProviderStatus>;
  require(providerId: AIProviderId): AIProvider;
  resolveModel(providerId: AIProviderId, modelId: string | null): Promise<AIModelInfo>;
};

type DiagnosticsSaveDialog = (options: {
  readonly title: string;
  readonly defaultPath: string;
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>;

export type DiagnosticsServiceDeps = Omit<PacketSources, 'providerStatuses'> & {
  readonly providers: DiagnosticsProviderRegistry;
  readonly showSaveDialog: DiagnosticsSaveDialog;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly log: Logger;
  readonly limits?: Partial<DiagnosticsRuntimeLimits>;
};

export type DiagnosticsRuntimeLimits = {
  readonly handleTtlMs: number;
  readonly maxHandles: number;
  readonly maxConcurrentAnalyses: number;
  readonly analysisTimeoutMs: number;
  readonly maxStreamEvents: number;
  /** How long a caller waits on a provider stop; the run stays counted until it settles. */
  readonly cancelWaitMs: number;
  /** How long shutdown waits on pending provider stops before the provider lifecycle takes over. */
  readonly shutdownWaitMs: number;
};

const DEFAULT_LIMITS: DiagnosticsRuntimeLimits = {
  handleTtlMs: 30 * 60 * 1_000,
  maxHandles: 4,
  maxConcurrentAnalyses: 2,
  analysisTimeoutMs: 120_000,
  maxStreamEvents: 20_000,
  cancelWaitMs: 500,
  shutdownWaitMs: 2_000,
};

/**
 * Providers whose inference runs over HTTP are never offered for diagnostics in
 * this version: neither adapter can yet guarantee that a cancelled request is
 * never sent, and OpenRouter's parser also accepts tool-call responses. Checked
 * before any registry or adapter access, so a forged request reaches neither.
 */
const EXCLUDED_TRANSPORTS: ReadonlySet<AIProviderId> = new Set<AIProviderId>(['local', 'openrouter']);

type Run = {
  readonly id: string;
  readonly requestId: string;
  cancelled: boolean;
  provider: AIProvider | null;
  readonly abort: () => void;
  readonly deadline: Deadline;
  cleanup: Promise<void> | null;
};

type Entry = {
  readonly handle: string;
  readonly ownerId: number;
  readonly packet: DiagnosticsPacket;
  readonly packetText: string;
  readonly expiry: NodeJS.Timeout;
  /** The reviewed issue and report; analysis and export require a preview. */
  reviewed: { readonly issue: string; readonly report: string } | null;
  run: Run | null;
};

class AnalysisFailed extends Error {
  constructor(readonly reason: DiagnosticsFailure) {
    super(reason);
  }
}

export class DiagnosticsService {
  private readonly entries = new Map<string, Entry>();
  private readonly cleaningRuns = new Set<Run>();
  /** The latest collection or disposal per window; values come from one counter so they never repeat. */
  private readonly ownerGenerations = new Map<number, number>();
  private generationCounter = 0;
  private readonly limits: DiagnosticsRuntimeLimits;
  private admissionClosed = false;
  constructor(private readonly deps: DiagnosticsServiceDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  /** Collects a fresh packet for one window, replacing that window's earlier one. */
  async collect(ownerId: number): Promise<DiagnosticsCollectResult> {
    this.requireOpen();
    const generation = this.nextGeneration(ownerId);

    const statuses = await this.deps.providers.listStatuses();
    this.requireOpen();
    if (this.ownerGenerations.get(ownerId) !== generation) {
      throw new InterleafError('validation', 'This diagnostics collection was cancelled or superseded.');
    }

    const packet = await collectDiagnosticsPacket({ ...this.deps, providerStatuses: () => Promise.resolve(statuses) });
    this.requireOpen();
    if (this.ownerGenerations.get(ownerId) !== generation) {
      throw new InterleafError('validation', 'This diagnostics collection was cancelled or superseded.');
    }

    this.disposeOwnerHandles(ownerId);
    if (this.entries.size >= this.limits.maxHandles) {
      throw new InterleafError('validation', 'Too many diagnostics reports are open. Close one and try again.');
    }
    const handle = randomUUID();
    const expiry = setTimeout(() => { this.drop(handle); }, this.limits.handleTtlMs);
    expiry.unref();
    const packetText = serializePacket(packet);
    this.entries.set(handle, { handle, ownerId, packet, packetText, expiry, reviewed: null, run: null });
    return { handle, packet, packetText, providers: eligibleProviders(statuses) };
  }

  /** Sanitizes the issue text and fixes the exact report the user reviews. */
  preview(ownerId: number, handle: string, issue: string): DiagnosticsPreviewResult {
    const entry = this.owned(ownerId, handle);
    if (entry.run !== null) throw new InterleafError('validation', 'Wait for the analysis to finish or cancel it first.');
    const sanitized = sanitizeFreeText(issue, DIAGNOSTICS_LIMITS.issueMaxLength);
    const report = buildReport({ packet: entry.packet, packetText: entry.packetText, issue: sanitized, analysis: null });
    entry.reviewed = { issue: sanitized, report };
    return { issue: sanitized, report };
  }

  /** Sends the reviewed packet and issue to one verified tool-free provider. */
  async analyze(ownerId: number, handle: string, providerId: DiagnosticsProviderId, modelId: string | null): Promise<DiagnosticsAnalyzeResult> {
    const entry = this.owned(ownerId, handle);
    const reviewed = entry.reviewed;
    if (reviewed === null) throw new InterleafError('validation', 'Review the report before analyzing it.');
    this.requireOpen();
    if (EXCLUDED_TRANSPORTS.has(providerId)) return { status: 'failed', reason: 'provider-unavailable' };
    if (entry.run !== null || this.activeCount() >= this.limits.maxConcurrentAnalyses) return { status: 'failed', reason: 'busy' };
    const requestId = randomUUID();
    const deadline = startDeadline(this.limits.analysisTimeoutMs);
    const run: Run = {
      id: randomUUID(),
      requestId,
      cancelled: false,
      provider: null,
      abort: deadline.abort,
      deadline,
      cleanup: null,
    };
    entry.run = run;
    try {
      const target = await deadline.race(this.verifiedTarget(providerId, modelId));
      const current = this.entries.get(handle);
      if (run.cancelled || current !== entry || current.run !== run || current.reviewed !== reviewed || this.admissionClosed) {
        throw new AnalysisFailed('cancelled');
      }
      run.provider = target.provider;
      const raw = await this.stream(run, {
        requestId,
        modelId: target.modelId,
        systemPrompt: DIAGNOSTICS_SYSTEM_PROMPT,
        contextXml: '',
        history: [],
        userMessage: buildAnalysisMessage(entry.packetText, reviewed.issue),
        sources: [],
        webSearch: false,
      }, deadline);
      if (isCancelled(run) || this.entries.get(handle) !== entry || entry.run !== run) throw new AnalysisFailed('cancelled');
      const text = sanitizeAnalysis(raw);
      if (text === null) throw new AnalysisFailed('empty');
      const analysis: ReportAnalysis = { providerId, modelId: sanitizeFreeText(target.modelId, 128), text };
      const report = buildReport({ packet: entry.packet, packetText: entry.packetText, issue: reviewed.issue, analysis });
      entry.reviewed = { issue: reviewed.issue, report };
      return { status: 'complete', issue: reviewed.issue, report };
    } catch (caught) {
      const reason = caught instanceof AnalysisFailed ? caught.reason : 'provider-failed';
      if (reason !== 'cancelled') this.deps.log.warn('Diagnostics analysis did not complete', { providerId, reason });
      return { status: 'failed', reason };
    } finally {
      deadline.clear();
      await this.releaseRun(entry, run);
    }
  }

  /** Stops the window's running analysis, if any; its late answer is discarded. */
  cancel(ownerId: number, handle: string): void {
    const entry = this.owned(ownerId, handle);
    this.stopRun(entry);
  }

  /** Writes the exact reviewed report to a file the user picks in a native dialog. */
  async exportReport(ownerId: number, handle: string): Promise<DiagnosticsExportResult> {
    const entry = this.owned(ownerId, handle);
    const reviewed = entry.reviewed;
    if (reviewed === null || entry.run !== null) throw new InterleafError('validation', 'Review the report before exporting it.');
    const chosen = await this.deps.showSaveDialog({
      title: 'Export Interleaf diagnostics report',
      defaultPath: 'Interleaf-diagnostics-report.md',
      filters: [{ name: 'Markdown report', extensions: ['md'] }],
    });
    if (chosen.canceled || chosen.filePath === undefined || chosen.filePath.length === 0) return { status: 'cancelled' };
    try {
      await this.deps.writeFile(chosen.filePath, reviewed.report);
    } catch (caught) {
      this.deps.log.warn('Diagnostics report export failed', { errorType: caught instanceof Error ? caught.name : 'unknown' });
      throw new InterleafError('validation', 'The diagnostics report could not be saved there. Choose another location.');
    }
    return { status: 'success', bytes: Buffer.byteLength(reviewed.report, 'utf8'), fileName: basename(chosen.filePath) };
  }

  /** Drops a handle the window dismissed. Unknown or foreign handles are ignored. */
  discard(ownerId: number, handle: string): void {
    const entry = this.entries.get(handle);
    if (entry?.ownerId === ownerId) this.drop(handle);
  }

  /** Drops every handle a window owned, when it navigates or is destroyed. */
  disposeOwner(ownerId: number): void {
    this.nextGeneration(ownerId);
    this.disposeOwnerHandles(ownerId);
    this.pruneOwnerGenerations();
  }

  private nextGeneration(ownerId: number): number {
    this.generationCounter += 1;
    this.ownerGenerations.set(ownerId, this.generationCounter);
    return this.generationCounter;
  }

  private disposeOwnerHandles(ownerId: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.ownerId === ownerId) this.drop(entry.handle);
    }
  }

  private pruneOwnerGenerations(): void {
    if (this.ownerGenerations.size > 64) {
      const activeOwners = new Set([...this.entries.values()].map((e) => e.ownerId));
      for (const [id] of this.ownerGenerations) {
        if (!activeOwners.has(id)) {
          this.ownerGenerations.delete(id);
        }
      }
    }
  }

  /** Live and still-stopping runs; a run being stopped is counted once, until its provider stop settles. */
  activeCount(): number {
    let count = this.cleaningRuns.size;
    for (const entry of this.entries.values()) if (entry.run !== null && !this.cleaningRuns.has(entry.run)) count += 1;
    return count;
  }

  closeAdmission(): void {
    this.admissionClosed = true;
  }

  /**
   * Closes admission, drops every handle and waits, bounded, for the provider
   * stops that started. A stop still pending afterwards stays counted until it
   * settles; the provider lifecycle's own shutdown ends it.
   */
  async shutdown(): Promise<void> {
    this.admissionClosed = true;
    this.ownerGenerations.clear();
    for (const handle of [...this.entries.keys()]) this.drop(handle);
    const pending = [...this.cleaningRuns].flatMap((run) => (run.cleanup === null ? [] : [run.cleanup]));
    if (pending.length > 0) await settleWithin(Promise.all(pending).then(() => undefined), this.limits.shutdownWaitMs);
  }

  private requireOpen(): void {
    if (this.admissionClosed) throw new InterleafError('validation', 'Interleaf is closing; diagnostics are unavailable.');
  }

  private owned(ownerId: number, handle: string): Entry {
    const entry = this.entries.get(handle);
    // A foreign handle reads exactly like an expired one.
    if (entry?.ownerId !== ownerId) throw new InterleafError('validation', 'This diagnostics report has expired. Run diagnostics again.');
    return entry;
  }

  private drop(handle: string): void {
    const entry = this.entries.get(handle);
    if (entry === undefined) return;
    this.entries.delete(handle);
    clearTimeout(entry.expiry);
    this.stopRun(entry);
  }

  private stopRun(entry: Entry): void {
    const run = entry.run;
    if (run === null) return;
    run.cancelled = true;
    run.abort();
    if (run.provider !== null) void this.beginCleanup(run);
  }

  /**
   * Starts the provider stop once and keeps the run reserved until that stop
   * actually settles, however long it takes, so an update restart still sees
   * the work as live.
   */
  private beginCleanup(run: Run): Promise<void> {
    if (run.cleanup !== null) return run.cleanup;
    const cleanup = cancelQuietlyAsync(run);
    run.cleanup = cleanup;
    this.cleaningRuns.add(run);
    void cleanup.then(() => { this.cleaningRuns.delete(run); });
    return cleanup;
  }

  private async releaseRun(entry: Entry, run: Run): Promise<void> {
    if (entry.run === run) {
      entry.run = null;
    }
    // A cancelled, timed-out or overlong run stays counted until its provider
    // stop settles; only this caller's wait for it is bounded.
    if (run.provider !== null && (run.cancelled || run.cleanup !== null)) {
      await settleWithin(this.beginCleanup(run), this.limits.cancelWaitMs);
    }
  }

  /**
   * Re-checks in main what the renderer chose: a ready, connected provider
   * that runs without tools, and one of the models it publishes. Anything else
   * fails closed, including a provider whose readiness changed since collection.
   */
  private async verifiedTarget(providerId: DiagnosticsProviderId, modelId: string | null): Promise<{ readonly provider: AIProvider; readonly modelId: string }> {
    if (EXCLUDED_TRANSPORTS.has(providerId)) throw new AnalysisFailed('provider-unavailable');
    let provider: AIProvider;
    let status: AIProviderStatus;
    try {
      provider = this.deps.providers.require(providerId);
      status = await this.deps.providers.getStatus(providerId);
    } catch {
      throw new AnalysisFailed('provider-unavailable');
    }
    if (provider.id !== providerId || status.id !== providerId || !isEligible(status)) throw new AnalysisFailed('provider-unavailable');
    if (modelId !== null && !status.models.some((model) => model.id === modelId)) throw new AnalysisFailed('model-unavailable');
    let resolved: AIModelInfo;
    try {
      resolved = await this.deps.providers.resolveModel(providerId, modelId);
    } catch {
      throw new AnalysisFailed('model-unavailable');
    }
    const listed = status.models.some((model) => model.id === resolved.id);
    if ((modelId !== null && resolved.id !== modelId) || !listed) throw new AnalysisFailed('model-unavailable');
    return { provider, modelId: resolved.id };
  }

  /** One bounded stream; partial output is never used. */
  private async stream(run: Run, request: ProviderChatRequest, deadline: Deadline): Promise<string> {
    if (run.provider === null) throw new AnalysisFailed('provider-unavailable');
    const iterator = run.provider.streamChat(request)[Symbol.asyncIterator]();
    let text = '';
    let events = 0;
    try {
      for (;;) {
        if (run.cancelled) throw new AnalysisFailed('cancelled');
        const step = await deadline.race(iterator.next());
        if (isCancelled(run)) throw new AnalysisFailed('cancelled');
        if (step.done === true) throw new AnalysisFailed('provider-failed');
        events += 1;
        if (events > this.limits.maxStreamEvents) throw new AnalysisFailed('too-long');
        if (step.value.type === 'done') return text;
        text += step.value.token;
        if (text.length > DIAGNOSTICS_LIMITS.analysisMaxLength) throw new AnalysisFailed('too-long');
      }
    } catch (caught) {
      if (!(caught instanceof AnalysisFailed)) throw caught;
      if (!run.cancelled && caught.reason !== 'provider-failed') {
        void this.beginCleanup(run);
      }
      throw run.cancelled ? new AnalysisFailed('cancelled') : caught;
    } finally {
      void iterator.return?.().catch(() => undefined);
    }
  }
}

/** Read through a call so a cancel that landed during an await is seen. */
function isCancelled(run: Run): boolean {
  return run.cancelled;
}

/** Waits for `work` (which never rejects) for at most `ms`, leaving no timer behind. */
async function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([work, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelQuietlyAsync(run: Run): Promise<void> {
  if (run.provider === null) return;
  try {
    await run.provider.cancel(run.requestId);
  } catch {
    // Provider cancellation errors are ignored
  }
}

/** Ready, signed in and tool-free: the providers diagnostics may offer. */
function isEligible(status: AIProviderStatus): boolean {
  return (
    !EXCLUDED_TRANSPORTS.has(status.id) &&
    status.available &&
    status.authentication === 'connected' &&
    status.capabilities.toolFreeMode &&
    status.models.length > 0
  );
}

function eligibleProviders(statuses: readonly AIProviderStatus[]): DiagnosticsProviderChoice[] {
  return AI_PROVIDER_IDS.flatMap((id) => {
    const status = statuses.find((entry) => entry.id === id);
    if (status === undefined || !isEligible(status)) return [];
    return [{ id, models: status.models.slice(0, 128).map((model) => ({ id: model.id, name: model.name })) }];
  }).slice(0, DIAGNOSTICS_LIMITS.maxProviders);
}

type Deadline = {
  readonly race: <T>(work: Promise<T>) => Promise<T>;
  readonly clear: () => void;
  readonly abort: () => void;
};

/** A single timer shared by every step of one analysis; `abort` ends it early as cancelled. */
function startDeadline(ms: number): Deadline {
  let timer: NodeJS.Timeout | undefined;
  let rejectStop: ((reason: AnalysisFailed) => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
    timer = setTimeout(() => { reject(new AnalysisFailed('timeout')); }, ms);
    timer.unref();
  });
  stopped.catch(() => undefined);
  return {
    race: (work) => Promise.race([work, stopped]),
    clear: () => { clearTimeout(timer); },
    abort: () => {
      clearTimeout(timer);
      rejectStop?.(new AnalysisFailed('cancelled'));
    },
  };
}
