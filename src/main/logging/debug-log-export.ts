import type { BrowserWindow } from 'electron';
import type { DebugLogExportResult } from '@shared/schemas/ipc';
import type { DurableLogExport, DurableLogSink } from './logger';

type DebugLogSaveDialogOptions = {
  readonly title: string;
  readonly defaultPath: string;
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
};

export type DebugLogSaveDialog = (
  parentWindow: BrowserWindow | null,
  options: DebugLogSaveDialogOptions,
) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>;

/**
 * Main-owned export orchestration. The renderer supplies no destination path;
 * the native dialog chooses it and the sink writes only sanitized bounded
 * current/rotated records.
 */
export function createDebugLogExporter(
  sink: DurableLogSink,
  showSaveDialog: DebugLogSaveDialog,
): (parentWindow: BrowserWindow | null) => Promise<DebugLogExportResult> {
  return async (parentWindow) => {
    const result = await showSaveDialog(parentWindow, {
      title: 'Export Interleaf debug log',
      defaultPath: 'Interleaf-debug-log.jsonl',
      filters: [{ name: 'JSONL log', extensions: ['jsonl'] }],
    });
    if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
      return { status: 'cancelled' };
    }
    const exported: DurableLogExport = await sink.exportTo(result.filePath);
    return { status: 'success', bytes: exported.bytes, fileName: exported.fileName };
  };
}
