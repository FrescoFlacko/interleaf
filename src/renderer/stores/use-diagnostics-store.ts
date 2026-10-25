import { create } from 'zustand';
import { InterleafError } from '@shared/errors/interleaf-error';
import type {
  DiagnosticsCollectResult,
  DiagnosticsFailure,
  DiagnosticsProviderId,
} from '@shared/schemas/diagnostics';
import { bridge } from '../app/api-client';

/**
 * Renderer state for private diagnostics.
 *
 * Main collects the packet, sanitizes the issue text, builds every report and
 * writes the export; this store only holds the opaque handle and what main
 * returned, so the panel shows exactly what would be sent or saved. Every
 * reply is tagged with the run that asked for it, so a reply that lands after
 * the user dismissed or restarted diagnostics is dropped.
 */

export type DiagnosticsStep = 'idle' | 'collecting' | 'ready' | 'reviewing' | 'analyzing' | 'exporting';

/** The exact report main will export, and whether it includes an analysis. */
type DiagnosticsReport = {
  readonly issue: string;
  readonly text: string;
  readonly analyzed: boolean;
};

export type DiagnosticsNotice =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'analysis-failed'; readonly reason: DiagnosticsFailure }
  | { readonly kind: 'exported'; readonly fileName: string }
  | { readonly kind: 'export-cancelled' };

type DiagnosticsStore = {
  readonly step: DiagnosticsStep;
  readonly collected: DiagnosticsCollectResult | null;
  readonly issue: string;
  readonly report: DiagnosticsReport | null;
  readonly notice: DiagnosticsNotice | null;
  readonly collect: () => Promise<void>;
  /** Editing the issue retires the reviewed report until it is reviewed again. */
  readonly setIssue: (issue: string) => void;
  readonly review: () => Promise<void>;
  readonly analyze: (providerId: DiagnosticsProviderId, modelId: string | null) => Promise<void>;
  readonly cancel: () => void;
  readonly exportReport: () => Promise<void>;
  /** Forgets the packet here and in main; called when the panel closes. */
  readonly discard: () => void;
};

const REQUEST_FAILED = 'Diagnostics could not complete that step. Try again.';

const ALLOWLISTED_RECOVERY_MESSAGES = [
  'This diagnostics report has expired. Run diagnostics again.',
  'The diagnostics report could not be saved there. Choose another location.',
  'Too many diagnostics reports are open. Close one and try again.',
  'Wait for the analysis to finish or cancel it first.',
  'Review the report before analyzing it.',
  'This diagnostics collection was cancelled or superseded.',
  'Interleaf is closing; diagnostics are unavailable.',
] as const;

export function failureMessage(caught: Error | { readonly message?: string } | null): string {
  if (caught instanceof InterleafError && caught.code === 'validation') {
    return caught.message;
  }
  if (caught !== null && typeof caught.message === 'string') {
    const raw = caught.message;
    for (const allowed of ALLOWLISTED_RECOVERY_MESSAGES) {
      if (raw === allowed || raw.includes(allowed)) {
        return allowed;
      }
    }
  }
  return REQUEST_FAILED;
}

const INITIAL = { step: 'idle', collected: null, issue: '', report: null, notice: null } as const;

export const useDiagnosticsStore = create<DiagnosticsStore>()((set, get) => {
  /** Identifies the current collection; bumped on every collect and discard. */
  let generation = 0;

  /** Runs one step against the current handle and applies its result only if that handle is still current. */
  async function step(
    busy: DiagnosticsStep,
    request: (handle: string) => Promise<Partial<DiagnosticsStore>>,
  ): Promise<void> {
    const { collected, step: current } = get();
    if (collected === null || current !== 'ready') return;
    const mine = generation;
    set({ step: busy, notice: null });
    let next: Partial<DiagnosticsStore>;
    try {
      next = await request(collected.handle);
    } catch (caught) {
      next = { notice: { kind: 'error', message: failureMessage(caught instanceof Error ? caught : null) } };
    }
    if (mine === generation) set({ ...next, step: 'ready' });
  }

  function release(): void {
    const handle = get().collected?.handle;
    generation += 1;
    if (handle !== undefined) void bridge.diagnostics.discard(handle).catch(() => undefined);
  }

  return {
    ...INITIAL,
    collect: async () => {
      if (get().step === 'collecting') return;
      release();
      const mine = generation;
      set({ ...INITIAL, step: 'collecting' });
      try {
        const collected = await bridge.diagnostics.collect();
        if (mine === generation) {
          set({ step: 'ready', collected });
        } else {
          void bridge.diagnostics.discard(collected.handle).catch(() => undefined);
        }
      } catch (caught) {
        if (mine === generation) {
          set({ step: 'idle', notice: { kind: 'error', message: failureMessage(caught instanceof Error ? caught : null) } });
        }
      }
    },
    setIssue: (issue) => {
      set({ issue, report: null });
    },
    review: () =>
      step('reviewing', async (handle) => {
        const preview = await bridge.diagnostics.preview(handle, get().issue);
        return { issue: preview.issue, report: { issue: preview.issue, text: preview.report, analyzed: false } };
      }),
    analyze: (providerId, modelId) =>
      step('analyzing', async (handle) => {
        if (get().report === null) return {};
        const result = await bridge.diagnostics.analyze(handle, providerId, modelId);
        if (result.status === 'failed') return { notice: { kind: 'analysis-failed', reason: result.reason } };
        return { report: { issue: result.issue, text: result.report, analyzed: true } };
      }),
    cancel: () => {
      const { collected, step: current } = get();
      if (collected === null || current !== 'analyzing') return;
      void bridge.diagnostics.cancel(collected.handle).catch(() => undefined);
    },
    exportReport: () =>
      step('exporting', async (handle) => {
        if (get().report === null) return {};
        const result = await bridge.diagnostics.exportReport(handle);
        return { notice: result.status === 'success' ? { kind: 'exported', fileName: result.fileName } : { kind: 'export-cancelled' } };
      }),
    discard: () => {
      release();
      set(INITIAL);
    },
  };
});
