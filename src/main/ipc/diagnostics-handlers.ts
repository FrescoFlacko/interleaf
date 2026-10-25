import { IPC } from '@shared/constants/ipc';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { IpcContracts } from '@shared/schemas/ipc';
import type { DiagnosticsService } from '../diagnostics/diagnostics-service';

/**
 * The private-diagnostics channels. Every handle is scoped to the renderer
 * that collected it: the owner is the invoking sender's id, never a value the
 * renderer sends, and a window's handles are dropped (and any analysis
 * cancelled) when that window is destroyed.
 */

export type DiagnosticsHandlerDeps = {
  readonly diagnostics: Pick<
    DiagnosticsService,
    'collect' | 'preview' | 'analyze' | 'cancel' | 'exportReport' | 'discard' | 'disposeOwner'
  >;
};

type DiagnosticsSender = {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
};

type DiagnosticsEvent = { readonly sender?: DiagnosticsSender };

type DiagnosticsChannel =
  | typeof IPC.diagnosticsCollect
  | typeof IPC.diagnosticsPreview
  | typeof IPC.diagnosticsAnalyze
  | typeof IPC.diagnosticsCancel
  | typeof IPC.diagnosticsExport
  | typeof IPC.diagnosticsDiscard;

type DiagnosticsHandlers = {
  [K in DiagnosticsChannel]: (
    request: IpcContracts[K]['parsed'],
    event: DiagnosticsEvent,
  ) => Promise<IpcContracts[K]['result']> | IpcContracts[K]['result'];
};

export function buildDiagnosticsHandlers(deps: DiagnosticsHandlerDeps): DiagnosticsHandlers {
  const watched = new WeakSet<DiagnosticsSender>();
  /** The live sender's id, after arranging for its handles to go with it. */
  const ownerOf = (event: DiagnosticsEvent): number => {
    const sender = event.sender;
    if (sender === undefined || sender.isDestroyed()) {
      throw new InterleafError('sender-rejected', 'Diagnostics require a live renderer sender.');
    }
    if (!watched.has(sender)) {
      watched.add(sender);
      const ownerId = sender.id;
      sender.once('destroyed', () => { deps.diagnostics.disposeOwner(ownerId); });
    }
    return sender.id;
  };
  return {
    [IPC.diagnosticsCollect]: (_request, event) => deps.diagnostics.collect(ownerOf(event)),
    [IPC.diagnosticsPreview]: (request, event) => deps.diagnostics.preview(ownerOf(event), request.handle, request.issue),
    [IPC.diagnosticsAnalyze]: (request, event) =>
      deps.diagnostics.analyze(ownerOf(event), request.handle, request.providerId, request.modelId),
    [IPC.diagnosticsCancel]: (request, event) => {
      deps.diagnostics.cancel(ownerOf(event), request.handle);
      return undefined;
    },
    [IPC.diagnosticsExport]: (request, event) => deps.diagnostics.exportReport(ownerOf(event), request.handle),
    [IPC.diagnosticsDiscard]: (request, event) => {
      deps.diagnostics.discard(ownerOf(event), request.handle);
      return undefined;
    },
  };
}
