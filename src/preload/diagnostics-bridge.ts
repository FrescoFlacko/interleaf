import type { z } from 'zod';
import { IPC } from '@shared/constants/ipc';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  diagnosticsAnalyzeResultSchema,
  diagnosticsCollectResultSchema,
  diagnosticsExportResultSchema,
  diagnosticsPreviewResultSchema,
} from '@shared/schemas/diagnostics';
import type { InterleafAPI } from '@shared/types/api';
import type { PreloadInvoke } from './index';

/**
 * Private diagnostics. The renderer names only the opaque handle main issued,
 * the issue text to review and the provider and model to ask; it never names a
 * file, a path or packet content. Every reply is re-parsed before the page
 * sees it.
 */
export function createDiagnosticsBridge(invoke: PreloadInvoke): InterleafAPI['diagnostics'] {
  function parsed<T>(schema: z.ZodType<T>, value: Awaited<ReturnType<PreloadInvoke>>): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new InterleafError('internal', 'The diagnostics response was invalid.');
    return result.data;
  }

  return {
    collect: async () => parsed(diagnosticsCollectResultSchema, await invoke(IPC.diagnosticsCollect)),
    preview: async (handle, issue) => parsed(diagnosticsPreviewResultSchema, await invoke(IPC.diagnosticsPreview, { handle, issue })),
    analyze: async (handle, providerId, modelId) =>
      parsed(diagnosticsAnalyzeResultSchema, await invoke(IPC.diagnosticsAnalyze, { handle, providerId, modelId })),
    cancel: async (handle) => { await invoke(IPC.diagnosticsCancel, { handle }); },
    exportReport: async (handle) => parsed(diagnosticsExportResultSchema, await invoke(IPC.diagnosticsExport, { handle })),
    discard: async (handle) => { await invoke(IPC.diagnosticsDiscard, { handle }); },
  };
}
