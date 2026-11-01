import { useState } from 'react';
import { bridge } from '../../app/api-client';
import type { SettingsFeedback } from './use-settings-feedback';

export type DebugLogExport = {
  readonly exporting: boolean;
  readonly exportLog: () => Promise<void>;
};

/**
 * Owns the diagnostics export: main chooses the destination through a native
 * Save dialog and writes only sanitized, bounded application records.
 */
export function useDebugLogExport(feedback: SettingsFeedback): DebugLogExport {
  const [exporting, setExporting] = useState(false);

  const exportLog = async (): Promise<void> => {
    setExporting(true);
    feedback.clear();
    try {
      const result = await bridge.app.exportDebugLog();
      if (result.status === 'cancelled') {
        feedback.announce('Debug log export cancelled. No file was written.');
      } else {
        feedback.announce(`Debug log exported successfully (${String(result.bytes)} bytes). It contains sanitized application diagnostics only.`);
      }
    } catch {
      // Keep native destination paths and main-process diagnostics out of the
      // renderer feedback channel; the main process logs a redacted diagnostic.
      feedback.fail('Debug log export failed. No file was written.');
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportLog };
}
